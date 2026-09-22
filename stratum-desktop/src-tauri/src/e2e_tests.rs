//! Integración contra el sidecar SEA real (`binaries/stratum-core-<triple>`).
//! Si el binario no está construido (`npm run sidecar:build`), los tests se
//! saltan con un aviso en vez de fallar: la CI de D4 los ejecuta tras el build.

use crate::sidecar::{self, LaunchSpec, ShutdownOutcome, SidecarProcess};
use crate::transport;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

fn manifest_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn sea_binary() -> Option<PathBuf> {
    let dir = manifest_dir().join("binaries");
    let entry = std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .find(|e| e.file_name().to_string_lossy().starts_with("stratum-core-"))?;
    Some(entry.path())
}

struct Launched {
    process: SidecarProcess,
    ipc_path: String,
    token: String,
    _tmp: tempfile::TempDir,
}

fn launch(bin: &Path) -> Launched {
    let tmp = tempfile::tempdir().unwrap();
    // Home propio del sidecar: nada de la config ni de los datos del usuario.
    // El provider apunta a un puerto cerrado; ningún test llega a llamarlo.
    let stratum_dir = tmp.path().join(".stratum");
    std::fs::create_dir_all(&stratum_dir).unwrap();
    std::fs::write(
        stratum_dir.join(".stratumrc.json"),
        json!({
            "provider": {
                "default": "e2e",
                "providers": { "e2e": {
                    "type": "openai-compatible",
                    "baseUrl": "http://127.0.0.1:9/v1",
                    "apiKey": "",
                    "model": "e2e-model",
                    "contextWindow": 8192
                } }
            },
            "memory": { "autoExtract": false }
        })
        .to_string(),
    )
    .unwrap();
    let (log, _) = crate::logs::open_sidecar_log(tmp.path(), 1 << 20, 1).unwrap();
    let token = sidecar::generate_token().unwrap();
    let ipc_path =
        sidecar::ipc_path(std::process::id(), &sidecar::random_suffix().unwrap()).unwrap();
    let process = SidecarProcess::spawn(LaunchSpec {
        exe: bin,
        ipc_path: &ipc_path,
        token: &token,
        resources_dir: &manifest_dir().join("resources"),
        cwd: tmp.path(),
        log,
        home: Some(tmp.path()),
    })
    .unwrap();
    Launched {
        process,
        ipc_path,
        token,
        _tmp: tmp,
    }
}

fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
}

#[test]
fn handshake_ping_y_apagado_ordenado() {
    let Some(bin) = sea_binary() else {
        eprintln!("SKIP: sin binario del sidecar; ejecuta `npm run sidecar:build`");
        return;
    };
    let mut l = launch(&bin);

    runtime().block_on(async {
        let stream = transport::connect(&l.ipc_path, Duration::from_secs(20), || Ok(()))
            .await
            .unwrap();
        let (r, mut w) = tokio::io::split(stream);
        let mut lines = BufReader::new(r).lines();

        w.write_all(transport::handshake_line(&l.token).as_bytes())
            .await
            .unwrap();
        let info =
            transport::parse_handshake_reply(&lines.next_line().await.unwrap().unwrap()).unwrap();
        assert_eq!(info.core["sea"], true, "el sidecar debe correr como SEA");
        let natives = info.natives.as_array().unwrap();
        assert!(
            natives.iter().all(|n| n["ok"] == true),
            "algún nativo no cargó: {natives:?}"
        );

        let ping = transport::outbound_line(&json!({"type": "ping", "id": "e2e"})).unwrap();
        w.write_all(ping.as_bytes()).await.unwrap();
        let pong: Value = serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
        assert_eq!(pong["type"], "pong");
        assert_eq!(pong["id"], "e2e");
    });

    assert!(
        l.process.try_exit().is_none(),
        "el sidecar murió antes de tiempo"
    );
    // Cerrar stdin → el sidecar ejecuta sus ganchos y sale con 0.
    assert_eq!(
        l.process.shutdown(sidecar::GRACE),
        ShutdownOutcome::Graceful(Some(0))
    );
}

#[test]
fn rechaza_un_token_incorrecto() {
    let Some(bin) = sea_binary() else {
        eprintln!("SKIP: sin binario del sidecar");
        return;
    };
    let l = launch(&bin);
    runtime().block_on(async {
        let stream = transport::connect(&l.ipc_path, Duration::from_secs(20), || Ok(()))
            .await
            .unwrap();
        let (r, mut w) = tokio::io::split(stream);
        let mut lines = BufReader::new(r).lines();
        w.write_all(transport::handshake_line(&"0".repeat(64)).as_bytes())
            .await
            .unwrap();
        let err = transport::parse_handshake_reply(&lines.next_line().await.unwrap().unwrap())
            .unwrap_err();
        assert!(err.contains("bad_token"), "{err}");
        // Tras el rechazo, el sidecar cierra la conexión.
        assert!(lines.next_line().await.unwrap().is_none());
    });
    l.process.shutdown(sidecar::GRACE);
}

/// Garantía de último recurso en Windows: si el proceso Tauri desaparece sin
/// apagar nada, el SO cierra el handle del Job Object y mata al sidecar. Aquí se
/// simula soltando `SidecarProcess` (que cierra el handle) sin llamar a `shutdown`.
#[cfg(windows)]
#[test]
fn soltar_el_job_object_mata_al_sidecar() {
    use windows_sys::Win32::Foundation::{CloseHandle, WAIT_OBJECT_0};
    use windows_sys::Win32::System::Threading::{
        OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE,
    };

    let Some(bin) = sea_binary() else {
        eprintln!("SKIP: sin binario del sidecar");
        return;
    };
    let mut l = launch(&bin);
    let pid = l.process.pid();
    // SAFETY: handle de solo sincronización sobre un PID vivo; se cierra al final.
    let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
    assert!(!handle.is_null());
    // Ni stdin cerrado de forma ordenada ni kill explícito: solo el job.
    std::mem::forget(l.process.stdin_for_test());
    drop(l.process);
    let waited = unsafe { WaitForSingleObject(handle, 5_000) };
    unsafe { CloseHandle(handle) };
    assert_eq!(
        waited, WAIT_OBJECT_0,
        "el sidecar {pid} sigue vivo tras cerrar el job"
    );
}

/// 15.1 contra el binario real: una trama de chat sin handshake previo se
/// rechaza y la conexión se cierra sin procesar nada.
#[test]
fn un_chat_sin_handshake_se_rechaza() {
    let Some(bin) = sea_binary() else {
        eprintln!("SKIP: sin binario del sidecar");
        return;
    };
    let l = launch(&bin);
    runtime().block_on(async {
        let stream = transport::connect(&l.ipc_path, Duration::from_secs(20), || Ok(()))
            .await
            .unwrap();
        let (r, mut w) = tokio::io::split(stream);
        let mut lines = BufReader::new(r).lines();
        let chat = json!({
            "type": "chat",
            "conversationId": "6f1c1c0e-3d2a-4b8e-9c1d-2f3a4b5c6d7e",
            "turnId": "t1",
            "text": "hola"
        });
        w.write_all(format!("{chat}\n").as_bytes()).await.unwrap();
        let reply: Value =
            serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
        assert_eq!(
            reply,
            json!({"type": "handshake_error", "reason": "expected_handshake"})
        );
        assert!(lines.next_line().await.unwrap().is_none());
    });
    l.process.shutdown(sidecar::GRACE);
}

/// D1 contra el binario real: tras autenticar se abre una conversación, y un
/// chat a otra que no está abierta se rechaza sin tocar ningún provider.
#[test]
fn abre_una_conversacion_tras_autenticar() {
    let Some(bin) = sea_binary() else {
        eprintln!("SKIP: sin binario del sidecar");
        return;
    };
    let l = launch(&bin);
    runtime().block_on(async {
        let stream = transport::connect(&l.ipc_path, Duration::from_secs(20), || Ok(()))
            .await
            .unwrap();
        let (r, mut w) = tokio::io::split(stream);
        let mut lines = BufReader::new(r).lines();
        w.write_all(transport::handshake_line(&l.token).as_bytes())
            .await
            .unwrap();
        transport::parse_handshake_reply(&lines.next_line().await.unwrap().unwrap()).unwrap();

        let id = "6f1c1c0e-3d2a-4b8e-9c1d-2f3a4b5c6d7e";
        for frame in [
            json!({"type": "new_conversation", "conversationId": id}),
            json!({
                "type": "chat",
                "conversationId": "6f1c1c0e-3d2a-4b8e-9c1d-000000000000",
                "turnId": "t1",
                "text": "hola"
            }),
        ] {
            let line = transport::outbound_line(&frame).unwrap();
            w.write_all(line.as_bytes()).await.unwrap();
        }
        let mut frames = Vec::new();
        // El error de config de arranque (si lo hay) puede llegar antes.
        while frames.len() < 2 {
            let line = tokio::time::timeout(Duration::from_secs(20), lines.next_line())
                .await
                .expect("sin respuesta del sidecar")
                .unwrap()
                .unwrap();
            let v: Value = serde_json::from_str(&line).unwrap();
            if v["type"] != "sidecar_error" {
                frames.push(v);
            }
        }
        assert_eq!(frames[0]["type"], "conversation_opened", "{frames:?}");
        assert_eq!(frames[0]["conversationId"], id);
        assert_eq!(frames[1]["type"], "chat_rejected", "{frames:?}");
        assert_eq!(frames[1]["reason"], "unknown_conversation");
    });
    assert_eq!(
        l.process.shutdown(sidecar::GRACE),
        ShutdownOutcome::Graceful(Some(0))
    );
}

/// D2 contra el binario real: el handshake anuncia la raíz de workspaces (bajo
/// el home del sidecar), abrir una conversación crea su carpeta, Rust puede
/// mandar `workspace_touch` y un adjunto inexistente se rechaza.
#[test]
fn workspace_de_una_conversacion() {
    let Some(bin) = sea_binary() else {
        eprintln!("SKIP: sin binario del sidecar");
        return;
    };
    let l = launch(&bin);
    let home = l._tmp.path().to_path_buf();
    runtime().block_on(async {
        let stream = transport::connect(&l.ipc_path, Duration::from_secs(20), || Ok(()))
            .await
            .unwrap();
        let (r, mut w) = tokio::io::split(stream);
        let mut lines = BufReader::new(r).lines();
        w.write_all(transport::handshake_line(&l.token).as_bytes())
            .await
            .unwrap();
        let info =
            transport::parse_handshake_reply(&lines.next_line().await.unwrap().unwrap()).unwrap();
        let ws = crate::workspace::WorkspacesInfo::from_handshake(
            info.workspaces.as_ref().expect("handshake sin workspaces"),
        )
        .unwrap();
        assert!(ws.root.starts_with(&home), "{:?} fuera de {home:?}", ws.root);
        assert_eq!(ws.max_file_bytes, 25 * 1024 * 1024);

        let id = "6f1c1c0e-3d2a-4b8e-9c1d-2f3a4b5c6d7e";
        let open = transport::outbound_line(&json!({"type": "new_conversation", "conversationId": id}))
            .unwrap();
        w.write_all(open.as_bytes()).await.unwrap();
        let touch = transport::internal_line(&json!({"type": "workspace_touch", "conversationId": id}));
        w.write_all(touch.as_bytes()).await.unwrap();
        let chat = transport::outbound_line(&json!({
            "type": "chat", "conversationId": id, "turnId": "t1",
            "text": "", "attachments": ["inputs/no-existe.pdf"]
        }))
        .unwrap();
        w.write_all(chat.as_bytes()).await.unwrap();
        // D3: fijar la conversación desde el webview (lista blanca de Rust).
        let pin = transport::outbound_line(
            &json!({"type": "workspace_pin", "conversationId": id, "pinned": true}),
        )
        .unwrap();
        w.write_all(pin.as_bytes()).await.unwrap();

        let mut frames = Vec::new();
        let mut statuses = Vec::new();
        while frames.len() < 2 || !statuses.iter().any(|s: &Value| s["pinned"] == true) {
            let line = tokio::time::timeout(Duration::from_secs(20), lines.next_line())
                .await
                .expect("sin respuesta del sidecar")
                .unwrap()
                .unwrap();
            let v: Value = serde_json::from_str(&line).unwrap();
            assert_ne!(v["code"], "protocol", "trama rechazada: {v}");
            if v["type"] == "workspace_status" {
                statuses.push(v["status"].clone());
            } else if v["type"] != "sidecar_error" {
                frames.push(v);
            }
        }
        assert_eq!(frames[0]["type"], "conversation_opened", "{frames:?}");
        assert_eq!(frames[0]["workspace"]["state"], "active", "{frames:?}");
        assert!(frames[0]["workspace"]["purgeAt"].is_string(), "{frames:?}");
        let pinned = statuses.iter().find(|s| s["pinned"] == true).unwrap();
        assert!(pinned["purgeAt"].is_null(), "{statuses:?}");
        assert_eq!(frames[1]["type"], "chat_rejected", "{frames:?}");
        assert_eq!(frames[1]["reason"], "bad_attachment");
        let dir = ws.conversation_dir(id).unwrap();
        for sub in ["inputs", "outputs", "scratch"] {
            assert!(dir.join(sub).is_dir(), "falta {sub}/");
        }
        assert!(dir.join(".workspace.json").is_file());
    });
    assert_eq!(
        l.process.shutdown(sidecar::GRACE),
        ShutdownOutcome::Graceful(Some(0))
    );
}
