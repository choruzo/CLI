//! Stratum Desktop: ventana Tauri + sidecar `stratum-core` con canal local
//! autenticado (D0), chat de asistente (D1) e integración con el SO (D6). Ver
//! STRATUM_DESKTOP_HITOS.md.

#[cfg(test)]
mod e2e_tests;
mod files;
mod ipc;
mod logs;
mod os;
mod sidecar;
mod supervisor;
mod transport;
mod workspace;

use ipc::SidecarState;
use os::OsState;
use tauri::{AppHandle, Manager, RunEvent, WindowEvent};
use workspace::WorkspaceState;

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
        // Solo lo usa Rust (D2): el webview no tiene permisos del plugin.
        .plugin(tauri_plugin_dialog::init())
        // D6: solo los usa Rust (`os.rs`); el webview no tiene sus permisos.
        .plugin(tauri_plugin_notification::init())
        .plugin(os::global_shortcut_plugin())
        .manage(SidecarState::new())
        .manage(WorkspaceState::default())
        .manage(OsState::default())
        .invoke_handler(tauri::generate_handler![
            ipc::sidecar_status,
            ipc::sidecar_subscribe,
            ipc::sidecar_send,
            ipc::sidecar_restart,
            ipc::sidecar_reload,
            files::attachments_pick,
            files::attachments_add,
            files::attachments_discard,
            files::output_save,
            files::output_open,
            files::output_preview,
            files::workspace_export,
            files::workspace_files,
            os::os_set_hotkey,
            os::os_notify,
            os::logs_open,
            os::logs_tail,
        ])
        .on_window_event(|window, event| {
            if let WindowEvent::DragDrop(drag) = event {
                files::on_drag_drop(window, drag);
            }
        })
        .setup(|app| {
            // Hasta que el sidecar diga cuál es el configurado (D6).
            os::register_default(app.handle());
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
