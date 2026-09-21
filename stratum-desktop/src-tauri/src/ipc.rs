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

use crate::sidecar::SidecarProcess;
use crate::transport;
use serde::Serialize;
use serde_json::Value;
use std::collections::VecDeque;
use std::sync::Mutex;
use std::time::Duration;
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
    Failed {
        message: String,
    },
}

#[derive(Default)]
struct Relay {
    subscriber: Option<Channel<Value>>,
    pending: VecDeque<Value>,
    outbound: Option<mpsc::UnboundedSender<String>>,
}

pub struct SidecarState {
    status: Mutex<SidecarStatus>,
    relay: Mutex<Relay>,
    process: Mutex<Option<SidecarProcess>>,
}

impl SidecarState {
    pub fn new() -> Self {
        Self {
            status: Mutex::new(SidecarStatus::Starting),
            relay: Mutex::new(Relay::default()),
            process: Mutex::new(None),
        }
    }

    pub fn set_process(&self, process: SidecarProcess) {
        *self.process.lock().unwrap() = Some(process);
    }

    pub fn take_process(&self) -> Option<SidecarProcess> {
        self.process.lock().unwrap().take()
    }

    fn exit_code(&self) -> Option<Option<i32>> {
        self.process
            .lock()
            .unwrap()
            .as_mut()
            .and_then(SidecarProcess::try_exit)
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
pub fn sidecar_send(state: State<'_, SidecarState>, frame: Value) -> Result<(), String> {
    let line = transport::outbound_line(&frame)?;
    let relay = state.relay.lock().unwrap();
    let tx = relay
        .outbound
        .as_ref()
        .ok_or("el sidecar no está conectado")?;
    tx.send(line)
        .map_err(|_| "el canal con el sidecar está cerrado".to_string())
}

// ---------------------------------------------------------------------------
// Relay
// ---------------------------------------------------------------------------

/// Conecta, autentica y reenvía tramas hasta que el pipe se cierra.
pub async fn run_relay(app: AppHandle, ipc_path: String, token: String) {
    match relay_once(&app, &ipc_path, &token).await {
        Ok(reason) => {
            let exit_code = app.state::<SidecarState>().exit_code().flatten();
            set_status(&app, SidecarStatus::Disconnected { reason, exit_code });
        }
        Err(message) => set_status(&app, SidecarStatus::Failed { message }),
    }
}

async fn relay_once(app: &AppHandle, ipc_path: &str, token: &str) -> Result<String, String> {
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

    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    state.relay.lock().unwrap().outbound = Some(tx);
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

    state.relay.lock().unwrap().outbound = None;
    writer_task.abort();
    // Deja un instante para que el proceso termine y su código quede disponible.
    tokio::time::sleep(Duration::from_millis(200)).await;
    Ok(reason)
}
