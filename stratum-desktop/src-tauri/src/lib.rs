//! Stratum Desktop (D0): ventana Tauri + sidecar `stratum-core` con canal
//! local autenticado. Ver STRATUM_DESKTOP_HITOS.md.

#[cfg(test)]
mod e2e_tests;
mod ipc;
mod logs;
mod sidecar;
mod transport;

use ipc::{SidecarState, SidecarStatus};
use sidecar::{LaunchSpec, SidecarProcess};
use tauri::{AppHandle, Manager, RunEvent};

/// Lanza el sidecar y arranca el relay. Un fallo no aborta la app: queda como
/// estado `failed` para que la UI lo muestre (D4 añadirá la pantalla de error).
fn launch_sidecar(app: &AppHandle) {
    if let Err(message) = try_launch(app) {
        ipc::set_status(app, SidecarStatus::Failed { message });
    }
}

fn try_launch(app: &AppHandle) -> Result<(), String> {
    let paths = app.path();
    // Sin directorio de logs de la app (perfil de usuario raro), el temporal del
    // sistema: quedarse sin log no puede dejar a la app sin agente.
    let log_dir = paths
        .app_log_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("stratum-desktop").join("logs"));
    let resources_dir = paths
        .resource_dir()
        .map_err(|e| format!("sin directorio de resources: {e}"))?;
    let home = paths
        .home_dir()
        .map_err(|e| format!("sin directorio home: {e}"))?;

    let (log, log_path) = logs::open_sidecar_log(&log_dir, logs::MAX_LOG_BYTES, logs::KEEP_ROTATED)
        .map_err(|e| format!("no se pudo abrir el log del sidecar: {e}"))?;
    let token =
        sidecar::generate_token().map_err(|e| format!("no se pudo generar el token: {e}"))?;
    let suffix = sidecar::random_suffix().map_err(|e| e.to_string())?;
    let ipc_path = sidecar::ipc_path(std::process::id(), &suffix)
        .map_err(|e| format!("no se pudo preparar el canal local: {e}"))?;
    let exe = sidecar::sidecar_exe_path().map_err(|e| e.to_string())?;
    if !exe.exists() {
        return Err(format!(
            "no se encuentra el sidecar en {} (¿falta `npm run sidecar:build`?)",
            exe.display()
        ));
    }

    let process = SidecarProcess::spawn(LaunchSpec {
        exe: &exe,
        ipc_path: &ipc_path,
        token: &token,
        resources_dir: &resources_dir,
        // El cwd de trabajo es por pestaña (D1, 15.3); el proceso arranca en home.
        cwd: &home,
        log,
    })
    .map_err(|e| format!("no se pudo lanzar {}: {e}", exe.display()))?;
    eprintln!(
        "[stratum] sidecar pid {} · log {}",
        process.pid(),
        log_path.display()
    );
    app.state::<SidecarState>().set_process(process);

    tauri::async_runtime::spawn(ipc::run_relay(app.clone(), ipc_path, token));
    Ok(())
}

fn shutdown_sidecar(app: &AppHandle) {
    if let Some(process) = app.state::<SidecarState>().take_process() {
        let outcome = process.shutdown(sidecar::GRACE);
        eprintln!("[stratum] sidecar detenido: {outcome:?}");
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(SidecarState::new())
        .invoke_handler(tauri::generate_handler![
            ipc::sidecar_status,
            ipc::sidecar_subscribe,
            ipc::sidecar_send,
        ])
        .setup(|app| {
            launch_sidecar(app.handle());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error al construir la aplicación Tauri")
        .run(|app, event| {
            // `Exit` llega tanto al cerrar la última ventana como al salir por
            // código. Si Tauri muere sin llegar aquí, el Job Object (Windows) o
            // PDEATHSIG + EOF en stdin (Linux) se encargan del sidecar.
            if let RunEvent::Exit = event {
                shutdown_sidecar(app);
            }
        });
}
