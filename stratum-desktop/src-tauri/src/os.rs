//! Integración con el sistema operativo (D6): atajo global, notificaciones
//! nativas y acceso a los logs del sidecar desde la UI.
//!
//! Las preferencias (`desktop.globalHotkey`, `desktop.notifications`) viven en
//! el `.stratumrc.json` que gestiona el sidecar (D5); el webview las recibe en
//! `config_state.applied.os` y se las pasa a Rust. Hasta que el sidecar conecta
//! se registra el atajo por defecto, para que la ventana se pueda traer al
//! frente aunque el agente no arranque.
//!
//! El webview no recibe permisos de los plugins: notificar y registrar el atajo
//! lo hace Rust a través de estos comandos, que acotan lo que se puede pedir.

use crate::logs;
use serde::Serialize;
use std::str::FromStr;
use std::sync::Mutex;
use tauri::plugin::TauriPlugin;
use tauri::{AppHandle, Manager, Runtime, State};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;

/// Igual que `DEFAULT_GLOBAL_HOTKEY` de `stratum-cli/src/config/accelerator.ts`.
pub const DEFAULT_HOTKEY: &str = "CommandOrControl+Shift+Space";

const MAX_TITLE_CHARS: usize = 80;
const MAX_BODY_CHARS: usize = 200;
const MAX_TAIL_LINES: usize = 200;

#[derive(Default)]
pub struct OsState {
    /// Atajo registrado ahora mismo (`None`: ninguno).
    hotkey: Mutex<Option<Shortcut>>,
}

/// Plugin del atajo global: el único atajo que se registra trae la ventana al frente.
pub fn global_shortcut_plugin<R: Runtime>() -> TauriPlugin<R> {
    tauri_plugin_global_shortcut::Builder::new()
        .with_handler(|app, _shortcut, event| {
            if event.state == ShortcutState::Pressed {
                bring_to_front(app);
            }
        })
        .build()
}

/// Restaura (si estaba minimizada u oculta) y enfoca la ventana principal.
pub fn bring_to_front<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Atajo por defecto al arrancar. Un fallo (otra app ya lo usa) no es fatal.
pub fn register_default<R: Runtime>(app: &AppHandle<R>) {
    let state = app.state::<OsState>();
    if let Err(e) = apply_hotkey(app, &state, DEFAULT_HOTKEY) {
        eprintln!("[stratum] atajo global por defecto no registrado: {e}");
    }
}

/// Sustituye el atajo registrado. Si el nuevo no se puede registrar, se
/// intenta recuperar el anterior. Devuelve el atajo que queda registrado.
fn apply_hotkey<R: Runtime>(
    app: &AppHandle<R>,
    state: &OsState,
    accelerator: &str,
) -> Result<Option<String>, String> {
    let accelerator = accelerator.trim();
    let wanted = if accelerator.is_empty() {
        None
    } else {
        Some(
            Shortcut::from_str(accelerator)
                .map_err(|e| format!("Atajo no válido «{accelerator}»: {e}"))?,
        )
    };
    let manager = app.global_shortcut();
    let mut current = state.hotkey.lock().unwrap();
    if *current == wanted {
        return Ok(wanted.map(|s| s.into_string()));
    }
    if let Some(old) = current.take() {
        let _ = manager.unregister(old);
        // Si no se registra el nuevo, se reintenta este.
        if let Some(new) = wanted {
            return match manager.register(new) {
                Ok(()) => {
                    *current = Some(new);
                    Ok(Some(new.into_string()))
                }
                Err(e) => {
                    let kept = manager.register(old).is_ok();
                    if kept {
                        *current = Some(old);
                    }
                    let mut msg = register_error(accelerator, &e);
                    if kept {
                        msg.push_str(&format!(". Sigue activo «{}»", old.into_string()));
                    }
                    Err(msg)
                }
            };
        }
        return Ok(None);
    }
    match wanted {
        None => Ok(None),
        Some(new) => {
            manager
                .register(new)
                .map_err(|e| register_error(accelerator, &e))?;
            *current = Some(new);
            Ok(Some(new.into_string()))
        }
    }
}

/// Mensaje para Ajustes: el caso habitual (otra app lo tiene) sin el `Debug` interno.
fn register_error(accelerator: &str, e: &tauri_plugin_global_shortcut::Error) -> String {
    let detail = e.to_string();
    if detail.contains("already registered") {
        format!("No se pudo registrar «{accelerator}»: otra aplicación ya usa ese atajo")
    } else {
        format!("No se pudo registrar «{accelerator}»: {detail}")
    }
}

/// `desktop.globalHotkey` efectivo, desde el webview. `""` desactiva el atajo.
#[tauri::command]
pub fn os_set_hotkey(
    app: AppHandle,
    state: State<'_, OsState>,
    accelerator: String,
) -> Result<Option<String>, String> {
    if accelerator.len() > 64 {
        return Err("atajo demasiado largo".into());
    }
    apply_hotkey(&app, &state, &accelerator)
}

/// Estado de la ventana principal que decide si una notificación tiene sentido.
#[derive(Debug, Clone, Copy)]
pub struct WindowPresence {
    pub focused: bool,
    pub minimized: bool,
    pub visible: bool,
}

/// Se notifica si el usuario no está mirando esa conversación: ventana sin
/// foco, minimizada u oculta, o una conversación que no es la visible.
pub fn should_notify(window: WindowPresence, active_conversation: bool) -> bool {
    let window_away = !window.focused || window.minimized || !window.visible;
    window_away || !active_conversation
}

/// Recorta a `max` caracteres (no bytes) con elipsis, y sin saltos de línea.
pub fn clip(text: &str, max: usize) -> String {
    let flat: String = text
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    let flat = flat.trim();
    if flat.chars().count() <= max {
        return flat.to_string();
    }
    let mut out: String = flat.chars().take(max.saturating_sub(1)).collect();
    out.push('…');
    out
}

/// Notificación nativa si la ventana no está a la vista (ver `should_notify`).
/// Devuelve si se mostró.
#[tauri::command]
pub fn os_notify(app: AppHandle, title: String, body: String, active_conversation: bool) -> bool {
    let presence = match app.get_webview_window("main") {
        Some(w) => WindowPresence {
            focused: w.is_focused().unwrap_or(false),
            minimized: w.is_minimized().unwrap_or(false),
            visible: w.is_visible().unwrap_or(true),
        },
        None => WindowPresence {
            focused: false,
            minimized: false,
            visible: false,
        },
    };
    if !should_notify(presence, active_conversation) {
        return false;
    }
    match app
        .notification()
        .builder()
        .title(clip(&title, MAX_TITLE_CHARS))
        .body(clip(&body, MAX_BODY_CHARS))
        .show()
    {
        Ok(()) => true,
        Err(e) => {
            eprintln!("[stratum] notificación no mostrada: {e}");
            false
        }
    }
}

/// Abre la carpeta de logs en el explorador de ficheros.
#[tauri::command]
pub fn logs_open(app: AppHandle) -> Result<(), String> {
    let dir = logs::log_dir(&app);
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("no se pudo crear {}: {e}", dir.display()))?;
    app.opener()
        .open_path(dir.to_string_lossy().to_string(), None::<&str>)
        .map_err(|e| format!("no se pudo abrir {}: {e}", dir.display()))
}

#[derive(Serialize)]
pub struct LogTail {
    path: String,
    text: String,
}

/// Últimas líneas de `sidecar.log`, para la pantalla de fallo de arranque.
#[tauri::command]
pub fn logs_tail(app: AppHandle, lines: usize) -> Result<LogTail, String> {
    let path = logs::log_dir(&app).join(logs::SIDECAR_LOG);
    let text = logs::read_tail(&path, lines.min(MAX_TAIL_LINES))
        .map_err(|e| format!("no se pudo leer {}: {e}", path.display()))?;
    Ok(LogTail {
        path: path.display().to_string(),
        text,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn presence(focused: bool, minimized: bool, visible: bool) -> WindowPresence {
        WindowPresence {
            focused,
            minimized,
            visible,
        }
    }

    #[test]
    fn notifica_solo_si_el_usuario_no_la_esta_viendo() {
        // A la vista y es la conversación visible: nada.
        assert!(!should_notify(presence(true, false, true), true));
        // Sin foco, minimizada u oculta.
        assert!(should_notify(presence(false, false, true), true));
        assert!(should_notify(presence(true, true, true), true));
        assert!(should_notify(presence(true, false, false), true));
        // Con foco pero otra conversación.
        assert!(should_notify(presence(true, false, true), false));
    }

    #[test]
    fn clip_cuenta_caracteres_y_aplana_saltos() {
        assert_eq!(clip("  hola\nmundo ", 80), "hola mundo");
        assert_eq!(clip("ñññññ", 3), "ññ…");
        assert_eq!(clip("abc", 3), "abc");
    }

    /// Las teclas que admite `parseAccelerator` (stratum-cli) las acepta Tauri.
    #[test]
    fn el_parser_de_tauri_acepta_las_teclas_del_schema() {
        let mut keys: Vec<String> = ('A'..='Z').map(String::from).collect();
        keys.extend(('0'..='9').map(String::from));
        keys.extend((1..=24).map(|n| format!("F{n}")));
        for k in [
            "Space",
            "Enter",
            "Tab",
            "Up",
            "Down",
            "Left",
            "Right",
            "Home",
            "End",
            "PageUp",
            "PageDown",
            "Insert",
            "Delete",
            "Backspace",
            "Backquote",
            "Minus",
            "Equal",
            "Comma",
            "Period",
            "Slash",
            "Semicolon",
            "Quote",
            "BracketLeft",
            "BracketRight",
            "Backslash",
        ] {
            keys.push(k.to_string());
        }
        for mods in ["CommandOrControl", "Control", "Alt", "Shift", "Super"] {
            for key in &keys {
                let acc = format!("{mods}+Alt+{key}");
                let acc = if mods == "Alt" {
                    format!("Alt+{key}")
                } else {
                    acc
                };
                assert!(Shortcut::from_str(&acc).is_ok(), "Tauri no acepta {acc}");
            }
        }
        assert!(Shortcut::from_str(DEFAULT_HOTKEY).is_ok());
    }
}
