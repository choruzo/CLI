//! Stratum Dot: el shell nativo. Una ventana, una bandeja y el enlace con el
//! daemon (`dot-link`). Nada más: Dot es un **cliente** del Stratum Protocol.
//!
//! ```text
//! webview (React)  ──invoke `dot_*`──►  commands.rs  ──►  dot-link  ──►  stratumd
//!                  ◄──`dot://event`───  (este fichero) ◄──  DotEvent
//! ```
//!
//! Reglas de este lado (ver `docs/dot.md`):
//!
//!  - El webview no recibe nunca el token del canal ni la ruta del endpoint, y
//!    solo puede pedir lo que hay en `commands.rs`.
//!  - Cerrar la ventana la oculta en la bandeja; «Quit Dot» termina Dot. Ninguna
//!    de las dos cosas toca el daemon ni sus sesiones.
//!  - Una sola instancia por usuario: abrir Dot otra vez enfoca la que ya hay.
//!  - La autoridad de aprobar es otra pieza (`dot_link::approver`), con otra
//!    conexión, y su clave se teclea en otra ventana (`unlock.rs`) que el
//!    webview principal no ve. Cerrar Dot la suelta.
//!  - Lo sensible se confirma en otra ventana más (`confirm.rs`), con lo que
//!    dice el daemon: el webview pide, la persona confirma allí, y solo
//!    entonces sale (`dot_link::confirm`). Cada cambio del enlace o del broker
//!    pasa por la puerta de confirmación, que se cancela si deja de tener sentido.

mod commands;
mod confirm;
mod page;
mod tray;
mod unlock;

use dot_link::approver::ApproverTimings;
use dot_link::discovery::default_endpoint_dir;
use dot_link::link::Timings;
use dot_link::{
    ApproverConfig, ApproverHandle, CancelReason, CliLauncher, ConfirmGate, ConfirmTimings,
    DotEvent, LinkConfig, LinkHandle, Logger,
};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, RunEvent, Runtime, WindowEvent};
use tauri_plugin_window_state::StateFlags;

/// Canal único nativo → interfaz (`DOT_EVENT` en `src/bridge/native.ts`).
pub const DOT_EVENT: &str = "dot://event";

/// `1` = no arrancar el daemon aunque no haya ninguno (tests, depuración).
pub const NO_AUTOSTART_ENV: &str = "STRATUM_DOT_NO_AUTOSTART";

pub struct DotState {
    pub link: LinkHandle,
    /// La autoridad de aprobar: otra conexión, bajo demanda.
    pub broker: ApproverHandle,
    /// La ventana de desbloqueo abierta ahora (su `nonce`), si la hay.
    pub prompt: unlock::UnlockPrompt,
    /// La confirmación nativa de lo sensible (una a la vez).
    pub confirm: Arc<ConfirmGate>,
    /// Qué ventana de confirmación enseña qué confirmación.
    pub confirm_windows: Arc<confirm::ConfirmWindows>,
    pub logger: Logger,
    /// `None` si el escritorio no tiene bandeja: entonces cerrar la ventana sale de Dot.
    pub tray: Option<tray::Tray>,
}

/// Trae la ventana al frente (desde la bandeja, o al abrir Dot por segunda vez).
pub fn show_main<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Tiene que ser el primer plugin: la segunda instancia sale aquí mismo.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            show_main(app)
        }))
        // Solo geometría, y solo de la principal: que estuviera oculta no se recuerda.
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(StateFlags::all() & !StateFlags::VISIBLE)
                .with_filter(|label| label == "main")
                .build(),
        )
        // Las páginas de desbloqueo y de confirmación, cada una en su origen y sin IPC.
        .register_asynchronous_uri_scheme_protocol(unlock::SCHEME, unlock::handle)
        .register_asynchronous_uri_scheme_protocol(confirm::SCHEME, confirm::handle)
        .invoke_handler(tauri::generate_handler![
            commands::dot_attach,
            commands::dot_retry,
            commands::dot_focus_session,
            commands::dot_resync_session,
            commands::dot_pause_run,
            commands::dot_resume_run,
            commands::dot_cancel_run,
            commands::dot_steer_run,
            commands::dot_open_session,
            commands::dot_start_run,
            commands::dot_list_agents,
            commands::dot_list_models,
            commands::dot_box_status,
            commands::dot_box_start,
            commands::dot_box_stop,
            commands::dot_approver_status,
            commands::dot_approver_unlock,
            commands::dot_approver_lock,
            commands::dot_approve,
            commands::dot_deny,
            commands::dot_answer_questions,
            commands::dot_decide_plan,
            commands::dot_set_attention,
            commands::dot_hide,
            commands::dot_quit,
        ])
        .on_window_event(|window, event| {
            if window.label().starts_with(confirm::WINDOW_PREFIX) {
                // Cerrar la ventana de confirmación es no confirmar.
                if let WindowEvent::Destroyed = event {
                    if let Some(state) = window.try_state::<DotState>() {
                        state.confirm_windows.closed(window.label(), &state.confirm);
                    }
                }
                return;
            }
            if window.label() == unlock::WINDOW {
                // Cerrar la ventana de desbloqueo la descarta: ya no se acepta nada de ella.
                if let WindowEvent::Destroyed = event {
                    if let Some(state) = window.try_state::<DotState>() {
                        state.prompt.clear();
                        // Cerrada a mitad de la comprobación: no queda nada desbloqueado.
                        if matches!(state.broker.status(), dot_link::ApproverStatus::Unlocking) {
                            state.broker.lock();
                        }
                    }
                }
                return;
            }
            if let WindowEvent::CloseRequested { api, .. } = event {
                // Con bandeja, cerrar es ocultar. Sin ella, cerrar sale de Dot
                // (si no, no habría forma de volver a la ventana ni de salir).
                let has_tray = window
                    .try_state::<DotState>()
                    .map(|s| s.tray.is_some())
                    .unwrap_or(false);
                if has_tray {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .setup(|app| {
            let handle = app.handle().clone();
            let log_dir = handle
                .path()
                .app_log_dir()
                .unwrap_or_else(|_| std::env::temp_dir().join("stratum-dot").join("logs"));
            let logger = Logger::to_dir(&log_dir);
            logger.info(&format!(
                "dot startup (version {})",
                env!("CARGO_PKG_VERSION")
            ));

            let endpoint_dir = default_endpoint_dir().ok_or("cannot resolve the home directory")?;
            let autostart = std::env::var(NO_AUTOSTART_ENV)
                .map(|v| v != "1")
                .unwrap_or(true);
            let config = LinkConfig {
                endpoint_dir,
                profile: dot_link::ClientProfile::DOT,
                client_version: env!("CARGO_PKG_VERSION").to_string(),
                autostart,
                launcher: Arc::new(CliLauncher::from_env()),
                logger: logger.clone(),
                timings: Timings::default(),
            };
            let gate = Arc::new(ConfirmGate::new(ConfirmTimings::default(), logger.clone()));
            let broker_emitter = handle.clone();
            let broker_gate = gate.clone();
            let (broker, broker_task) = dot_link::spawn_broker(
                ApproverConfig {
                    endpoint_dir: config.endpoint_dir.clone(),
                    client_version: env!("CARGO_PKG_VERSION").to_string(),
                    logger: logger.clone(),
                    timings: ApproverTimings::default(),
                },
                move |event: DotEvent| {
                    // Bloqueado, caducado o perdido: la confirmación abierta ya no vale.
                    broker_gate.on_event(&event);
                    // Solo el estado del broker: nunca la clave ni nada derivado.
                    let _ = broker_emitter.emit_to("main", DOT_EVENT, &event);
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
                tray::on_event(&emitter, &event);
                // Lo que se emite es `DotEvent`: por construcción no lleva el token.
                let _ = emitter.emit_to("main", DOT_EVENT, &event);
            });

            let tray = tray::build(&handle, &logger);
            app.manage(DotState {
                link,
                broker,
                prompt: unlock::UnlockPrompt::default(),
                confirm: gate,
                confirm_windows: Arc::new(confirm::ConfirmWindows::default()),
                logger,
                tray,
            });
            tauri::async_runtime::spawn(task);
            tauri::async_runtime::spawn(broker_task);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error al construir Stratum Dot")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                // Dot desaparece: se sueltan las conexiones y nada más. Ni
                // `core.shutdown`, ni cancelar runs, ni cerrar sesiones, ni
                // resolver lo pendiente. La autoridad de aprobar se va con Dot.
                if let Some(state) = app.try_state::<DotState>() {
                    state.prompt.clear();
                    // Una confirmación abierta no sobrevive a Dot: no se envía.
                    state.confirm.invalidate(CancelReason::Closing);
                    state.broker.shutdown();
                    state.link.shutdown();
                    state.logger.info("dot exit");
                }
            }
        });
}
