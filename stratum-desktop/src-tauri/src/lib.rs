//! Stratum Desktop: ventana Tauri, cliente de `stratumd` (M12).
//!
//! Desde M12 Desktop es un **cliente hermano** de la CLI y de Stratum Dot
//! (`docs/STRATUM_CLIENT_ARCHITECTURE.md`): no tiene runtime de agente ni
//! sidecar. Habla el Stratum Protocol con el daemon por el enlace nativo
//! compartido (`dot_link`, perfil [`ClientProfile::DESKTOP`]): descubre el
//! daemon, lo arranca con el comando oficial (`stratum daemon start`) si no
//! hay ninguno, se suscribe y reenvía al webview lo que llega, sin
//! interpretarlo. Cerrar Desktop suelta la conexión y nada más: el daemon, sus
//! sesiones y sus runs siguen.
//!
//! Lo que sigue siendo de Desktop (interfaz, no estado de sesión): la ventana
//! (D7), el atajo global y las notificaciones (D6), las actualizaciones (D7) y
//! los ficheros de las conversaciones del asistente (D2: subidas, descargas,
//! vista previa), confinados a su carpeta.

mod commands;
mod files;
mod logs;
mod os;
mod prefs;
mod updates;
mod window_state;
mod workspace;

use dot_link::discovery::default_endpoint_dir;
use dot_link::link::Timings;
use dot_link::{CliLauncher, ClientProfile, DotEvent, LinkConfig, LinkHandle, Logger};
use os::OsState;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, RunEvent, WindowEvent};
use window_state::WindowStateStore;
use workspace::WorkspaceState;

/// Canal único nativo → interfaz: mantiene el orden entre fotos, eventos y estado.
pub const DESKTOP_EVENT: &str = "desktop://event";

/// `STRATUM_DESKTOP_NO_AUTOSTART=1`: no arrancar el daemon (pruebas).
const NO_AUTOSTART_ENV: &str = "STRATUM_DESKTOP_NO_AUTOSTART";

/// Lo que la app tiene en marcha. Nada de esto es estado de una sesión.
pub struct DesktopState {
    pub link: LinkHandle,
    pub prefs: prefs::DesktopPrefs,
    pub hotkey_error: Option<String>,
    pub logger: Logger,
}

/// Lo que hay que hacer antes de que el proceso termine: guardar dónde estaba
/// la ventana. Lo usan la salida normal y el instalador de una actualización
/// (que en Windows sale con `process::exit`). No hay nada más que apagar.
pub(crate) fn prepare_exit<R: tauri::Runtime>(app: &AppHandle<R>) {
    window_state::save(app);
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
        // D7: solo lo usa Rust (`updates.rs`); el webview no tiene sus permisos.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(WorkspaceState::default())
        .manage(OsState::default())
        .manage(WindowStateStore::default())
        .manage(updates::UpdateState::default())
        .invoke_handler(tauri::generate_handler![
            commands::desktop_attach,
            commands::desktop_retry,
            commands::desktop_focus_session,
            commands::desktop_resync_session,
            commands::desktop_pause_run,
            commands::desktop_resume_run,
            commands::desktop_cancel_run,
            commands::desktop_steer_run,
            commands::desktop_new_chat,
            commands::desktop_start_run,
            commands::desktop_list_models,
            commands::desktop_set_model,
            commands::desktop_close_session,
            commands::desktop_history,
            commands::desktop_context,
            commands::desktop_memory,
            commands::desktop_prefs,
            commands::desktop_open_config,
            files::attachments_pick,
            files::attachments_add,
            files::attachments_commit,
            files::attachments_discard,
            files::output_save,
            files::output_open,
            files::output_preview,
            files::workspace_export,
            files::workspace_files,
            os::os_notify,
            os::logs_open,
            os::logs_tail,
            updates::update_check,
            updates::update_install,
        ])
        .on_window_event(|window, event| {
            if let WindowEvent::DragDrop(drag) = event {
                files::on_drag_drop(window, drag);
            }
            // D7: la ventana es frameless; su posición se guarda para
            // restaurarla ajustada a los monitores que haya al volver.
            window_state::track(window, event);
        })
        .setup(|app| {
            let handle = app.handle().clone();
            // Arranca oculta: se coloca donde estaba y entonces se muestra.
            window_state::restore(&handle);

            let logger = Logger::to_file(&logs::log_dir(&handle), logs::LINK_LOG);
            logger.info(&format!(
                "desktop startup (version {})",
                env!("CARGO_PKG_VERSION")
            ));
            let home = handle
                .path()
                .home_dir()
                .map_err(|_| "cannot resolve the home directory")?;
            let prefs = prefs::load(&home);
            for warning in &prefs.warnings {
                logger.warn(warning);
            }
            handle
                .state::<WorkspaceState>()
                .set_info(Some(prefs.workspaces()));
            let hotkey_error = os::register_configured(&handle, &prefs.global_hotkey);

            // El mecanismo oficial de los clientes: descubrir `~/.stratum/daemon/`
            // y, si no hay daemon, `stratum daemon start` (una vez por intento).
            let endpoint_dir = default_endpoint_dir().ok_or("cannot resolve the home directory")?;
            let autostart = std::env::var(NO_AUTOSTART_ENV)
                .map(|v| v != "1")
                .unwrap_or(true);
            let config = LinkConfig {
                endpoint_dir,
                profile: ClientProfile::DESKTOP,
                client_version: env!("CARGO_PKG_VERSION").to_string(),
                autostart,
                launcher: Arc::new(CliLauncher::from_env_var(
                    dot_link::launcher::DESKTOP_CLI_ENV,
                )),
                logger: logger.clone(),
                timings: Timings::default(),
            };
            let emitter = handle.clone();
            let (link, task) = dot_link::spawn(config, move |event: DotEvent| {
                // Lo que se emite es `DotEvent`: por construcción no lleva el token.
                let _ = emitter.emit_to("main", DESKTOP_EVENT, &event);
            });
            app.manage(DesktopState {
                link,
                prefs,
                hotkey_error,
                logger,
            });
            tauri::async_runtime::spawn(task);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error al construir la aplicación Tauri")
        .run(|app, event| {
            // `Exit` llega tanto al cerrar la última ventana como al salir por
            // código. Desktop desaparece: se suelta la conexión y nada más. Ni
            // `core.shutdown`, ni cancelar runs, ni cerrar sesiones.
            if let RunEvent::Exit = event {
                prepare_exit(app);
                if let Some(state) = app.try_state::<DesktopState>() {
                    state.link.shutdown();
                    state.logger.info("desktop exit");
                }
            }
        });
}
