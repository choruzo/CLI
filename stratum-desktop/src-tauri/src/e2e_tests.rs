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
