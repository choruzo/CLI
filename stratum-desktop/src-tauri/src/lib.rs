//! Stratum Desktop: ventana Tauri + sidecar `stratum-core` con canal local
//! autenticado (D0) y chat de asistente (D1). Ver STRATUM_DESKTOP_HITOS.md.

#[cfg(test)]
mod e2e_tests;
mod ipc;
mod logs;
mod sidecar;
mod supervisor;
mod transport;

use ipc::SidecarState;
use tauri::{AppHandle, Manager, RunEvent};

/// Salida de la app: se marca antes de apagar, así el supervisor no relanza el
/// sidecar que se está deteniendo.
fn shutdown_sidecar(app: &AppHandle) {
    if let Some(process) = app.state::<SidecarState>().begin_exit() {
        let outcome = process.shutdown(sidecar::GRACE);
        eprintln!("[stratum] sidecar detenido: {outcome:?}");
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(SidecarState::new())
        .invoke_handler(tauri::generate_handler![
            ipc::sidecar_status,
            ipc::sidecar_subscribe,
            ipc::sidecar_send,
            ipc::sidecar_restart,
        ])
        .setup(|app| {
            // Un fallo al lanzar no aborta la app: queda como estado `failed`
            // para que la UI lo muestre, con Reintentar.
            supervisor::start(app.handle().clone());
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
