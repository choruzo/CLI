//! Bandeja del sistema. Mínima a propósito (M6, M8):
//!
//! ```text
//! ├── Open Stratum Dot
//! ├── Sessions: N              (informativo)
//! ├── Waiting for you: …       (informativo: aprobaciones, preguntas, planes)
//! ├── Open Approval Center
//! └── Quit Dot                 (cierra Dot, no el daemon)
//! ```
//!
//! Desde la bandeja **no se aprueba nada**: solo se abre el centro, donde se
//! ve qué se pide.
//!
//! Ninguna función depende de ella: en un escritorio sin bandeja (GNOME sin
//! extensión, o sin `libayatana-appindicator`) Dot funciona con la ventana, y
//! «Quit Dot» está también en su pie. Ver `docs/dot.md` (Q4).

use dot_link::{ConnectionState, DotEvent, Logger};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, Runtime, UserAttentionType, Wry};

use crate::{show_main, DotState, DOT_EVENT};

/// `1` = no crear la bandeja (para probar el comportamiento sin ella).
pub const NO_TRAY_ENV: &str = "STRATUM_DOT_NO_TRAY";

pub struct Tray {
    icon: TrayIcon<Wry>,
    sessions: MenuItem<Wry>,
    pending: MenuItem<Wry>,
    /// Lo último que se enseñó: para saber si apareció algo nuevo.
    last_pending: std::sync::Mutex<u32>,
}

fn sessions_label(count: usize) -> String {
    format!("Sessions: {count}")
}

fn plural(n: u32, one: &str, many: &str) -> String {
    format!("{n} {}", if n == 1 { one } else { many })
}

fn pending_label(approvals: u32, questions: u32, plans: u32) -> String {
    if approvals + questions + plans == 0 {
        return "Nothing waiting for you".into();
    }
    let parts: Vec<String> = [
        (approvals, "approval", "approvals"),
        (questions, "question", "questions"),
        (plans, "plan", "plans"),
    ]
    .iter()
    .filter(|(n, _, _)| *n > 0)
    .map(|(n, one, many)| plural(*n, one, many))
    .collect();
    format!("Waiting for you: {}", parts.join(" · "))
}

/// Abre la ventana en el centro de aprobaciones.
pub fn open_approval_center<R: Runtime>(app: &AppHandle<R>) {
    show_main(app);
    let _ = app.emit_to(
        "main",
        DOT_EVENT,
        serde_json::json!({ "type": "open-view", "view": "human-input" }),
    );
}

/// Lo pendiente que enseña la interfaz. Si apareció algo nuevo y la ventana no
/// tiene el foco, se pide atención (parpadeo en la barra de tareas): no se le
/// roba el foco a nadie ni se abre nada.
pub fn set_pending<R: Runtime>(
    app: &AppHandle<R>,
    state: &DotState,
    approvals: u32,
    questions: u32,
    plans: u32,
) {
    let total = approvals.saturating_add(questions).saturating_add(plans);
    let grew = match &state.tray {
        Some(tray) => {
            let _ = tray
                .pending
                .set_text(pending_label(approvals, questions, plans));
            let mut last = tray.last_pending.lock().unwrap_or_else(|e| e.into_inner());
            let grew = total > *last;
            *last = total;
            grew
        }
        None => total > 0,
    };
    if grew {
        if let Some(window) = app.get_webview_window("main") {
            if !window.is_focused().unwrap_or(false) {
                let _ = window.request_user_attention(Some(UserAttentionType::Informational));
            }
        }
    }
}

fn tooltip(state: &ConnectionState, sessions: usize) -> String {
    let status = match state {
        ConnectionState::Connected { .. } => {
            return format!(
                "Stratum Dot — {sessions} live session{}",
                if sessions == 1 { "" } else { "s" }
            );
        }
        ConnectionState::Starting | ConnectionState::Connecting => "connecting",
        ConnectionState::DaemonStarting => "starting the daemon",
        ConnectionState::Reconnecting { .. } => "reconnecting",
        ConnectionState::Incompatible { .. } => "incompatible daemon",
        ConnectionState::Error { .. } => "not connected",
    };
    format!("Stratum Dot — {status}")
}

/// Crea la bandeja. `None` si el escritorio no la admite: Dot sigue sin ella.
pub fn build(app: &AppHandle<Wry>, logger: &Logger) -> Option<Tray> {
    if std::env::var(NO_TRAY_ENV)
        .map(|v| v == "1")
        .unwrap_or(false)
    {
        logger.info("tray disabled by environment");
        return None;
    }
    // En Linux, sin la librería del indicador, crear la bandeja puede abortar
    // con un pánico en vez de devolver un error.
    let app_for_build = app.clone();
    let built =
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || create(&app_for_build)));
    match built {
        Ok(Ok(tray)) => Some(tray),
        Ok(Err(error)) => {
            logger.warn(&format!("no system tray: {error}"));
            None
        }
        Err(_) => {
            logger.warn("no system tray: the desktop does not provide one");
            None
        }
    }
}

fn create(app: &AppHandle<Wry>) -> tauri::Result<Tray> {
    let open = MenuItem::with_id(app, "open", "Open Stratum Dot", true, None::<&str>)?;
    let sessions = MenuItem::with_id(app, "sessions", sessions_label(0), false, None::<&str>)?;
    let pending = MenuItem::with_id(app, "pending", pending_label(0, 0, 0), false, None::<&str>)?;
    let center = MenuItem::with_id(app, "approvals", "Open Approval Center", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Dot", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &open,
            &sessions,
            &pending,
            &center,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;

    let mut builder = TrayIconBuilder::with_id("main")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip(tooltip(&ConnectionState::Starting, 0))
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => show_main(app),
            "approvals" => open_approval_center(app),
            // Cierra Dot. El daemon no se entera.
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    Ok(Tray {
        icon: builder.build(app)?,
        sessions,
        pending,
        last_pending: std::sync::Mutex::new(0),
    })
}

/// Mantiene al día el contador y el texto de la bandeja. Solo lee el sobre del
/// evento: ni fotos ni eventos de sesión.
pub fn on_event<R: Runtime>(app: &AppHandle<R>, event: &DotEvent) {
    if !matches!(
        event,
        DotEvent::Connection { .. } | DotEvent::Sessions { .. }
    ) {
        return;
    }
    let Some(state) = app.try_state::<DotState>() else {
        return;
    };
    let Some(tray) = &state.tray else { return };
    let count = state.link.session_count();
    let _ = tray.sessions.set_text(sessions_label(count));
    let _ = tray
        .icon
        .set_tooltip(Some(tooltip(&state.link.connection(), count)));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lo_pendiente_en_la_bandeja() {
        assert_eq!(pending_label(0, 0, 0), "Nothing waiting for you");
        assert_eq!(pending_label(2, 0, 0), "Waiting for you: 2 approvals");
        assert_eq!(
            pending_label(1, 1, 3),
            "Waiting for you: 1 approval · 1 question · 3 plans"
        );
    }

    #[test]
    fn el_texto_de_la_bandeja() {
        assert_eq!(sessions_label(3), "Sessions: 3");
        let connected = ConnectionState::Connected {
            server_version: "0.9.0".into(),
            server_platform: "win32".into(),
            protocol: 1,
            capabilities: vec![],
            features: vec![],
        };
        assert_eq!(tooltip(&connected, 1), "Stratum Dot — 1 live session");
        assert_eq!(tooltip(&connected, 2), "Stratum Dot — 2 live sessions");
        assert_eq!(
            tooltip(&ConnectionState::Reconnecting { attempt: 4 }, 2),
            "Stratum Dot — reconnecting"
        );
        assert_eq!(
            tooltip(
                &ConnectionState::Error {
                    message: "x".into()
                },
                0
            ),
            "Stratum Dot — not connected"
        );
    }
}
