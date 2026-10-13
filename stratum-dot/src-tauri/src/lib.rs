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

mod commands;
mod tray;

use dot_link::discovery::default_endpoint_dir;
use dot_link::link::Timings;
use dot_link::{CliLauncher, DotEvent, LinkConfig, LinkHandle, Logger};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, RunEvent, Runtime, WindowEvent};
use tauri_plugin_window_state::StateFlags;

/// Canal único nativo → interfaz (`DOT_EVENT` en `src/bridge/native.ts`).
pub const DOT_EVENT: &str = "dot://event";

/// `1` = no arrancar el daemon aunque no haya ninguno (tests, depuración).
pub const NO_AUTOSTART_ENV: &str = "STRATUM_DOT_NO_AUTOSTART";

pub struct DotState {
    pub link: LinkHandle,
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
        // Solo geometría: que estuviera oculta en la bandeja no se recuerda.
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(StateFlags::all() & !StateFlags::VISIBLE)
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            commands::dot_attach,
            commands::dot_retry,
            commands::dot_focus_session,
            commands::dot_resync_session,
            commands::dot_pause_run,
            commands::dot_resume_run,
            commands::dot_cancel_run,
            commands::dot_steer_run,
            commands::dot_hide,
            commands::dot_quit,
        ])
        .on_window_event(|window, event| {
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
                client_version: env!("CARGO_PKG_VERSION").to_string(),
                autostart,
                launcher: Arc::new(CliLauncher::from_env()),
                logger: logger.clone(),
                timings: Timings::default(),
            };
            let emitter = handle.clone();
            let (link, task) = dot_link::spawn(config, move |event: DotEvent| {
                tray::on_event(&emitter, &event);
                // Lo que se emite es `DotEvent`: por construcción no lleva el token.
                let _ = emitter.emit(DOT_EVENT, &event);
            });

            let tray = tray::build(&handle, &logger);
            app.manage(DotState { link, logger, tray });
            tauri::async_runtime::spawn(task);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error al construir Stratum Dot")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                // Dot desaparece: se suelta la conexión y nada más. Ni
                // `core.shutdown`, ni cancelar runs, ni cerrar sesiones.
                if let Some(state) = app.try_state::<DotState>() {
                    state.link.shutdown();
                    state.logger.info("dot exit");
                }
            }
        });
}
