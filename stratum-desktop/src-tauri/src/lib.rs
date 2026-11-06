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
//!
//! La autoridad de aprobar es la de Stratum Dot (M8/M9): otra conexión
//! (`dot_link::approver`, bajo demanda), cuya clave se teclea en otra ventana
//! (`unlock.rs`) que el webview principal no ve, y lo sensible solo sale
//! confirmado en otra más (`confirm.rs`). Cerrar Desktop la suelta.

mod commands;
mod confirm;
mod files;
mod images;
mod logs;
mod os;
mod page;
mod prefs;
mod retention;
mod settings;
mod settings_cli;
mod settings_gate;
mod unlock;
mod updates;
mod window_state;
mod workspace;

use dot_link::approver::ApproverTimings;
use dot_link::discovery::{default_endpoint_dir, home_dir};
use dot_link::link::Timings;
use dot_link::{
    ApproverConfig, ApproverHandle, CancelReason, CliLauncher, ClientProfile, ConfirmGate,
    ConfirmTimings, DotEvent, LinkConfig, LinkHandle, Logger,
};
use os::OsState;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, RunEvent, WindowEvent};
use window_state::WindowStateStore;
use workspace::WorkspaceState;

/// Canal único nativo → interfaz: mantiene el orden entre fotos, eventos y estado.
pub const DESKTOP_EVENT: &str = "desktop://event";

/// Cada cuánto se repite el barrido de retención de las carpetas de conversación
/// (el primero va justo tras arrancar, con una pequeña espera).
const RETENTION_EVERY: std::time::Duration = std::time::Duration::from_secs(6 * 3600);
const RETENTION_FIRST_DELAY: std::time::Duration = std::time::Duration::from_secs(20);

/// `STRATUM_DESKTOP_NO_AUTOSTART=1`: no arrancar el daemon (pruebas).
const NO_AUTOSTART_ENV: &str = "STRATUM_DESKTOP_NO_AUTOSTART";

/// Lo que la app tiene en marcha. Nada de esto es estado de una sesión.
pub struct DesktopState {
    pub link: LinkHandle,
    /// La autoridad de aprobar: otra conexión, bajo demanda.
    pub broker: ApproverHandle,
    /// La ventana de desbloqueo abierta ahora (su `nonce`), si la hay.
    pub prompt: unlock::UnlockPrompt,
    /// La confirmación nativa de lo sensible (una a la vez).
    pub confirm: Arc<ConfirmGate>,
    /// Qué ventana de confirmación enseña qué confirmación.
    pub confirm_windows: Arc<confirm::ConfirmWindows>,
    /// La confirmación nativa de un cambio de ajustes de nivel B (otra puerta, la misma ventana).
    pub settings_gate: Arc<settings_gate::SettingsGate>,
    /// Un cambio de ajustes a la vez (leer, confirmar, releer, escribir).
    pub settings_busy: std::sync::Mutex<()>,
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

/// Retención de las carpetas de conversación (`retention.rs`): un barrido al
/// arrancar y otro cada pocas horas, en un hilo propio. No lo para nada y no
/// hace falta pararlo: cada paso es seguro de interrumpir (se archiva a un
/// temporal y solo se retira la carpeta tras verificarlo).
fn spawn_retention(app: AppHandle, logger: Logger) {
    // Sin hilo no hay retención; las carpetas se conservan, que es lo seguro.
    let _ = std::thread::Builder::new()
        .name("retention".into())
        .spawn(move || {
            std::thread::sleep(RETENTION_FIRST_DELAY);
            loop {
                let report = app
                    .state::<WorkspaceState>()
                    .sweep(std::time::SystemTime::now());
                if !report.archived.is_empty() || !report.purged.is_empty() {
                    logger.info(&format!(
                        "retention: {} archived, {} purged",
                        report.archived.len(),
                        report.purged.len()
                    ));
                }
                for (id, reason) in &report.failed {
                    logger.warn(&format!("retention: {id}: {reason}"));
                }
                std::thread::sleep(RETENTION_EVERY);
            }
        });
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
        // Las páginas de desbloqueo y de confirmación, cada una en su origen y sin IPC.
        .register_asynchronous_uri_scheme_protocol(unlock::SCHEME, unlock::handle)
        .register_asynchronous_uri_scheme_protocol(confirm::SCHEME, confirm::handle)
        .invoke_handler(tauri::generate_handler![
            commands::desktop_attach,
            commands::desktop_retry,
            commands::desktop_focus_session,
            commands::desktop_resync_session,
            commands::desktop_trace_session,
            commands::desktop_pause_run,
            commands::desktop_resume_run,
            commands::desktop_cancel_run,
            commands::desktop_steer_run,
            commands::desktop_new_chat,
            commands::desktop_start_run,
            commands::desktop_save_pasted_image,
            commands::desktop_list_models,
            commands::desktop_set_model,
            commands::desktop_close_session,
            commands::desktop_history,
            commands::desktop_context,
            commands::desktop_memory,
            commands::desktop_list_skills,
            commands::desktop_memory_decisions,
            commands::desktop_memory_forget,
            commands::desktop_prefs,
            commands::desktop_open_config,
            commands::desktop_settings_get,
            commands::desktop_settings_set,
            commands::desktop_settings_add_provider,
            commands::desktop_approver_status,
            commands::desktop_approver_unlock,
            commands::desktop_approver_lock,
            commands::desktop_approve,
            commands::desktop_deny,
            commands::desktop_answer_questions,
            commands::desktop_decide_plan,
            files::attachments_pick,
            files::attachments_add,
            files::attachments_commit,
            files::attachments_discard,
            files::output_save,
            files::output_open,
            files::output_preview,
            files::workspace_export,
            files::workspace_files,
            files::workspace_restore,
            os::os_notify,
            os::logs_open,
            os::logs_tail,
            updates::update_check,
            updates::update_install,
        ])
        .on_window_event(|window, event| {
            if window.label().starts_with(confirm::WINDOW_PREFIX) {
                // Cerrar la ventana de confirmación es no confirmar.
                if let WindowEvent::Destroyed = event {
                    if let Some(state) = window.try_state::<DesktopState>() {
                        if let Some(nonce) = state.confirm_windows.take(window.label()) {
                            state.confirm.cancel(&nonce);
                            state.settings_gate.cancel(&nonce);
                        }
                    }
                }
                return;
            }
            if window.label() == unlock::WINDOW {
                // Cerrar la ventana de desbloqueo la descarta: ya no se acepta nada de ella.
                if let WindowEvent::Destroyed = event {
                    if let Some(state) = window.try_state::<DesktopState>() {
                        state.prompt.clear();
                        // Cerrada a mitad de la comprobación: no queda nada desbloqueado.
                        if matches!(state.broker.status(), dot_link::ApproverStatus::Unlocking) {
                            state.broker.lock();
                        }
                    }
                }
                return;
            }
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
            // El mismo home que el enlace (y que Node): `USERPROFILE`/`HOME`, no la
            // carpeta de perfil del SO, que ignora un HOME aislado (las E2E).
            let home = home_dir().ok_or("cannot resolve the home directory")?;
            let prefs = prefs::load(&home);
            for warning in &prefs.warnings {
                logger.warn(warning);
            }
            handle
                .state::<WorkspaceState>()
                .set_info(Some(prefs.workspaces()));
            let hotkey_error = os::register_configured(&handle, &prefs.global_hotkey);
            spawn_retention(handle.clone(), logger.clone());

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
            let gate = Arc::new(ConfirmGate::new(ConfirmTimings::default(), logger.clone()));
            let broker_emitter = handle.clone();
            let broker_gate = gate.clone();
            let (broker, broker_task) = dot_link::spawn_broker(
                ApproverConfig {
                    endpoint_dir: config.endpoint_dir.clone(),
                    profile: ClientProfile::DESKTOP,
                    client_version: env!("CARGO_PKG_VERSION").to_string(),
                    logger: logger.clone(),
                    timings: ApproverTimings::default(),
                },
                move |event: DotEvent| {
                    // Bloqueado, caducado o perdido: la confirmación abierta ya no vale.
                    broker_gate.on_event(&event);
                    // Solo el estado del broker: nunca la clave ni nada derivado.
                    let _ = broker_emitter.emit_to("main", DESKTOP_EVENT, &event);
                },
            );
            let emitter = handle.clone();
            let observer = broker.clone();
            let link_gate = gate.clone();
            let (link, task) = dot_link::spawn(config, move |event: DotEvent| {
                if let DotEvent::Connection { state } = &event {
                    observer.observe_main(state);
                }
                // Resuelta en otro sitio, sesión que se va, daemon perdido: se cancela.
                link_gate.on_event(&event);
                // Lo que se emite es `DotEvent`: por construcción no lleva el token.
                let _ = emitter.emit_to("main", DESKTOP_EVENT, &event);
            });
            app.manage(DesktopState {
                link,
                broker,
                prompt: unlock::UnlockPrompt::default(),
                confirm: gate,
                confirm_windows: Arc::new(confirm::ConfirmWindows::default()),
                settings_gate: Arc::new(settings_gate::SettingsGate::new(
                    settings_gate::SettingsTimings::default(),
                    logger.clone(),
                )),
                settings_busy: std::sync::Mutex::new(()),
                prefs,
                hotkey_error,
                logger,
            });
            tauri::async_runtime::spawn(task);
            tauri::async_runtime::spawn(broker_task);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error al construir la aplicación Tauri")
        .run(|app, event| {
            // `Exit` llega tanto al cerrar la última ventana como al salir por
            // código. Desktop desaparece: se sueltan las conexiones y nada más. Ni
            // `core.shutdown`, ni cancelar runs, ni cerrar sesiones, ni resolver
            // lo pendiente. La autoridad de aprobar se va con Desktop.
            if let RunEvent::Exit = event {
                prepare_exit(app);
                if let Some(state) = app.try_state::<DesktopState>() {
                    state.prompt.clear();
                    // Una confirmación abierta no sobrevive a Desktop: no se envía.
                    state.confirm.invalidate(CancelReason::Closing);
                    state.settings_gate.invalidate();
                    state.broker.shutdown();
                    state.link.shutdown();
                    state.logger.info("desktop exit");
                }
            }
        });
}
