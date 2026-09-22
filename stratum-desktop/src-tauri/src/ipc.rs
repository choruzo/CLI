//! Relay webview ⇄ sidecar y comandos Tauri expuestos al frontend.
//!
//! El webview no puede abrir un named pipe ni un unix socket, así que todo el
//! tráfico con el sidecar pasa por aquí por un único canal ordenado:
//! - sidecar → webview: `sidecar_subscribe` registra un `Channel` que recibe
//!   cada trama tal cual llega del pipe.
//! - webview → sidecar: `sidecar_send` valida y escribe la trama en el pipe.
//! - estado de la conexión: evento `sidecar://status` (y `sidecar://ready` al
//!   conectar) más `sidecar_status` para leerlo al montar la UI.
//!
//! Como stream y control comparten este único canal, un `cancel` (D1) nunca
//! adelanta a los chunks que ya estaban en vuelo (15.9).
//!
//! Quién lanza el sidecar y cuándo se relanza lo decide `supervisor.rs`; aquí
//! vive el estado compartido y un ciclo de relay (`relay_once`).

use crate::sidecar::SidecarProcess;
use crate::transport;
use crate::workspace::{WorkspaceState, WorkspacesInfo};
use serde::Serialize;
use serde_json::Value;
use std::collections::VecDeque;
use std::sync::mpsc::Sender;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::mpsc;

pub const EVENT_STATUS: &str = "sidecar://status";
pub const EVENT_READY: &str = "sidecar://ready";

/// Tramas que se guardan mientras el frontend aún no se ha suscrito (p. ej. el
/// `sidecar_error` de config incompatible, que llega justo tras el handshake).
const PENDING_LIMIT: usize = 256;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum SidecarStatus {
    Starting,
    Connected {
        core: Value,
        natives: Value,
    },
    Disconnected {
        reason: String,
        #[serde(rename = "exitCode")]
        exit_code: Option<i32>,
    },
    /// El sidecar se cayó y el supervisor lo relanzará tras `delay_ms` (15.5).
    Reconnecting {
        attempt: u32,
        #[serde(rename = "maxAttempts")]
        max_attempts: u32,
        #[serde(rename = "delayMs")]
        delay_ms: u64,
        reason: String,
    },
    Failed {
        message: String,
    },
}

#[derive(Default)]
struct Relay {
    subscriber: Option<Channel<Value>>,
    pending: VecDeque<Value>,
    /// Canal hacia el pipe, etiquetado con la generación del relay que lo abrió.
    outbound: Option<(u64, mpsc::UnboundedSender<String>)>,
}

/// Proceso del sidecar + si la app está saliendo, bajo un mismo mutex: así
/// instalar un proceso y empezar la salida no pueden cruzarse.
#[derive(Default)]
struct ProcessSlot {
    exiting: bool,
    process: Option<SidecarProcess>,
}

pub struct SidecarState {
    status: Mutex<SidecarStatus>,
    relay: Mutex<Relay>,
    process: Mutex<ProcessSlot>,
    supervisor: Mutex<Option<Sender<crate::supervisor::Command>>>,
}

impl SidecarState {
    pub fn new() -> Self {
        Self {
            status: Mutex::new(SidecarStatus::Starting),
            relay: Mutex::new(Relay::default()),
            process: Mutex::new(ProcessSlot::default()),
            supervisor: Mutex::new(None),
        }
    }

    pub fn set_supervisor(&self, tx: Sender<crate::supervisor::Command>) {
        *self.supervisor.lock().unwrap() = Some(tx);
    }

    /// Instala el proceso recién lanzado. Si la app ya está saliendo, lo
    /// devuelve para que quien lo lanzó lo apague.
    pub fn install_process(&self, process: SidecarProcess) -> Result<(), SidecarProcess> {
        let mut slot = self.process.lock().unwrap();
        if slot.exiting {
            return Err(process);
        }
        slot.process = Some(process);
        Ok(())
    }

    pub fn take_process(&self) -> Option<SidecarProcess> {
        self.process.lock().unwrap().process.take()
    }

    pub fn is_exiting(&self) -> bool {
        self.process.lock().unwrap().exiting
    }

    /// Empieza la salida de la app: ningún proceso más se instalará, el
    /// supervisor deja de esperar (se suelta su canal) y se devuelve el
    /// proceso vivo para apagarlo.
    pub fn begin_exit(&self) -> Option<SidecarProcess> {
        let process = {
            let mut slot = self.process.lock().unwrap();
            slot.exiting = true;
            slot.process.take()
        };
        self.supervisor.lock().unwrap().take();
        process
    }

    fn exit_code(&self) -> Option<Option<i32>> {
        self.process
            .lock()
            .unwrap()
            .process
            .as_mut()
            .and_then(SidecarProcess::try_exit)
    }

    /// Trama que origina Rust (D2: `workspace_touch`), sin pasar por la lista
    /// blanca del frontend.
    pub fn send_internal(&self, frame: Value) -> Result<(), String> {
        let relay = self.relay.lock().unwrap();
        let (_, tx) = relay
            .outbound
            .as_ref()
            .ok_or("el sidecar no está conectado")?;
        tx.send(transport::internal_line(&frame))
            .map_err(|_| "el canal con el sidecar está cerrado".to_string())
    }

    fn forward(&self, frame: Value) {
        let mut relay = self.relay.lock().unwrap();
        if let Some(ch) = &relay.subscriber {
            if ch.send(frame.clone()).is_ok() {
                return;
            }
            // El webview se recargó y el canal ya no existe: se guarda hasta
            // que se vuelva a suscribir.
            relay.subscriber = None;
        }
        if relay.pending.len() == PENDING_LIMIT {
            relay.pending.pop_front();
        }
        relay.pending.push_back(frame);
    }
}

impl Default for SidecarState {
    fn default() -> Self {
        Self::new()
    }
}

pub fn set_status(app: &AppHandle, status: SidecarStatus) {
    match &status {
        SidecarStatus::Connected { core, .. } => {
            eprintln!("[stratum] sidecar conectado: core {}", core["version"])
        }
        other => eprintln!("[stratum] sidecar: {other:?}"),
    }
    let state = app.state::<SidecarState>();
    *state.status.lock().unwrap() = status.clone();
    if let SidecarStatus::Connected { .. } = &status {
        let _ = app.emit(EVENT_READY, &status);
    }
    let _ = app.emit(EVENT_STATUS, &status);
}

// ---------------------------------------------------------------------------
// Comandos
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn sidecar_status(state: State<'_, SidecarState>) -> SidecarStatus {
    state.status.lock().unwrap().clone()
}

#[tauri::command]
pub fn sidecar_subscribe(state: State<'_, SidecarState>, on_frame: Channel<Value>) {
    let mut relay = state.relay.lock().unwrap();
    for frame in relay.pending.drain(..) {
        let _ = on_frame.send(frame);
    }
    relay.subscriber = Some(on_frame);
}

#[tauri::command]
pub fn sidecar_send(
    state: State<'_, SidecarState>,
    workspaces: State<'_, WorkspaceState>,
    frame: Value,
) -> Result<(), String> {
    let line = transport::outbound_line(&frame)?;
    {
        let relay = state.relay.lock().unwrap();
        let (_, tx) = relay
            .outbound
            .as_ref()
            .ok_or("el sidecar no está conectado")?;
        tx.send(line)
            .map_err(|_| "el canal con el sidecar está cerrado".to_string())?;
    }
    // Un `chat` con adjuntos los hace parte de la conversación: ya no se
    // pueden descartar (D2).
    if frame.get("type").and_then(Value::as_str) == Some("chat") {
        if let (Some(cid), Some(list)) = (
            frame.get("conversationId").and_then(Value::as_str),
            frame.get("attachments").and_then(Value::as_array),
        ) {
            let paths: Vec<String> = list
                .iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect();
            workspaces.commit(cid, &paths);
        }
    }
    Ok(())
}

/// Reintentar tras agotar los reinicios automáticos (botón de la UI).
#[tauri::command]
pub fn sidecar_restart(state: State<'_, SidecarState>) -> Result<(), String> {
    let supervisor = state.supervisor.lock().unwrap();
    let tx = supervisor
        .as_ref()
        .ok_or("la aplicación se está cerrando")?;
    tx.send(crate::supervisor::Command::Restart)
        .map_err(|_| "el supervisor del sidecar no está activo".to_string())
}

// ---------------------------------------------------------------------------
// Relay
// ---------------------------------------------------------------------------

/// Fin de un relay que llegó a conectar.
pub struct RelayEnd {
    pub reason: String,
    /// Cuánto duró la conexión autenticada (decide si se reinicia el backoff).
    pub connected_for: Duration,
}

/// Conecta, autentica y reenvía tramas hasta que el pipe se cierra. `Err` si
/// no llegó a conectar.
pub async fn relay_once(
    app: &AppHandle,
    ipc_path: &str,
    token: &str,
    generation: u64,
) -> Result<RelayEnd, String> {
    let state = app.state::<SidecarState>();
    let stream = transport::connect(ipc_path, CONNECT_TIMEOUT, || match state.exit_code() {
        Some(code) => Err(format!(
            "el sidecar terminó durante el arranque (código {code:?}); ver logs/sidecar.log"
        )),
        None => Ok(()),
    })
    .await?;

    let (reader, mut writer) = tokio::io::split(stream);
    let mut lines = BufReader::new(reader).lines();

    writer
        .write_all(transport::handshake_line(token).as_bytes())
        .await
        .map_err(|e| format!("no se pudo enviar el handshake: {e}"))?;
    let reply = tokio::time::timeout(HANDSHAKE_TIMEOUT, lines.next_line())
        .await
        .map_err(|_| "el sidecar no respondió al handshake".to_string())?
        .map_err(|e| format!("error leyendo el handshake: {e}"))?
        .ok_or("el sidecar cerró la conexión durante el handshake")?;
    let info = transport::parse_handshake_reply(&reply)?;
    app.state::<WorkspaceState>().set_info(
        info.workspaces
            .as_ref()
            .and_then(WorkspacesInfo::from_handshake),
    );

    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    {
        let mut relay = state.relay.lock().unwrap();
        relay.outbound = Some((generation, tx));
        // Tramas de un sidecar anterior que el frontend no llegó a recoger: ya
        // no significan nada para este.
        relay.pending.clear();
    }
    let connected_at = Instant::now();
    set_status(
        app,
        SidecarStatus::Connected {
            core: info.core,
            natives: info.natives,
        },
    );

    let writer_task = tokio::spawn(async move {
        while let Some(line) = rx.recv().await {
            if writer.write_all(line.as_bytes()).await.is_err() {
                break;
            }
        }
    });

    let reason = loop {
        match lines.next_line().await {
            Ok(Some(line)) => match serde_json::from_str::<Value>(&line) {
                Ok(frame) => state.forward(frame),
                Err(e) => eprintln!("[stratum] trama del sidecar no es JSON: {e}"),
            },
            Ok(None) => break "el sidecar cerró la conexión".to_string(),
            Err(e) => break format!("error leyendo del sidecar: {e}"),
        }
    };

    {
        let mut relay = state.relay.lock().unwrap();
        if matches!(relay.outbound, Some((g, _)) if g == generation) {
            relay.outbound = None;
        }
    }
    writer_task.abort();
    // Deja un instante para que el proceso termine y su código quede disponible.
    tokio::time::sleep(Duration::from_millis(200)).await;
    let exit_code = state.exit_code().flatten();
    set_status(
        app,
        SidecarStatus::Disconnected {
            reason: reason.clone(),
            exit_code,
        },
    );
    Ok(RelayEnd {
        reason: match exit_code {
            Some(code) => format!("{reason} (código de salida {code})"),
            None => reason,
        },
        connected_for: connected_at.elapsed(),
    })
}
