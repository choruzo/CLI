//! M16 — la notificación del sistema cuando termina una rutina (PRD §23.5).
//!
//! El webview **no** tiene el permiso del plugin de notificaciones: solo puede
//! pedir `dot_notify_routine`, y este lado valida el texto (plano, acotado) y la
//! muestra. Una notificación no lleva acciones ni resuelve nada: en particular,
//! nunca aprueba ni deniega una solicitud.
//!
//! **El clic.** En el escritorio el plugin oficial no avisa de que se pulsó la
//! notificación (`onAction` es de móvil).
//!
//! - **Windows**: el aviso se muestra aquí con `tauri-winrt-notification` y su
//!   evento `Activated` (llega a este proceso mientras Dot sigue abierto) trae
//!   la ventana y abre la sesión. Sin activador COM en el acceso directo,
//!   Windows no relanza la app al pulsar, así que el foco no serviría: se probó
//!   con Dot instalado y el clic no hacía nada.
//! - **Resto**: lo que sí se sabe es que la ventana recibe el foco. Si ocurre
//!   poco después de mostrar una, Dot abre la sesión de esa rutina. Se recuerda
//!   solo la última, solo `FOCUS_WINDOW` y solo hasta el primer foco: pulsar la
//!   notificación y cambiar de ventana a mano justo después son, desde aquí, lo
//!   mismo.
//!
//! Abrir la sesión solo la selecciona.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Runtime};
#[cfg(not(windows))]
use tauri_plugin_notification::NotificationExt;

/// Tope del título (caracteres).
pub const MAX_TITLE_CHARS: usize = 120;
/// Tope del cuerpo (caracteres).
pub const MAX_BODY_CHARS: usize = 400;
/// Cuánto después de mostrarla vale un foco como «pulsó la notificación».
/// Corto a propósito: el aviso del sistema dura unos segundos, y volver a Dot a
/// mano más tarde no debe cambiar la sesión seleccionada.
pub const FOCUS_WINDOW: Duration = Duration::from_secs(30);

/// Texto plano y acotado: sin caracteres de control (los saltos pasan a espacio),
/// espacios colapsados y recortado por caracteres, con `…` si se recorta.
pub fn plain(text: &str, max: usize) -> String {
    let mut out = String::new();
    let mut space = false;
    for ch in text.chars() {
        if ch.is_whitespace() || ch.is_control() {
            space = !out.is_empty();
            continue;
        }
        if space {
            out.push(' ');
            space = false;
        }
        out.push(ch);
    }
    if out.chars().count() > max {
        let mut cut: String = out.chars().take(max.saturating_sub(1)).collect();
        cut.push('…');
        return cut;
    }
    out
}

/// La sesión de la última notificación mostrada, hasta el primer foco.
#[derive(Default)]
pub struct PendingNotice(Mutex<Option<(String, Instant)>>);

impl PendingNotice {
    pub fn remember(&self, session_id: String, at: Instant) {
        if let Ok(mut slot) = self.0.lock() {
            *slot = Some((session_id, at));
        }
    }

    /// La sesión a abrir si la ventana recibe el foco ahora. Se consume: un
    /// solo foco la abre.
    pub fn take_fresh(&self, now: Instant) -> Option<String> {
        let (id, at) = self.0.lock().ok()?.take()?;
        (now.saturating_duration_since(at) <= FOCUS_WINDOW).then_some(id)
    }
}

/// Muestra la notificación; `on_click` se llama al pulsarla donde el sistema lo
/// dice (Windows). Un fallo del sistema (sin servicio de notificaciones,
/// permiso denegado) no es un error de Dot: se devuelve el texto para el log y
/// nada más.
#[cfg(windows)]
pub fn show<R: Runtime>(
    app: &AppHandle<R>,
    title: &str,
    body: &str,
    on_click: impl Fn() + Send + 'static,
) -> Result<(), String> {
    use tauri_winrt_notification::Toast;
    // El mismo AppUserModelID que el plugin: el de Dot instalado; desde `target/`
    // (sin acceso directo que lo registre), el de PowerShell.
    let exe = tauri::utils::platform::current_exe().map_err(|e| e.to_string())?;
    let dir = exe
        .parent()
        .map(|d| d.display().to_string())
        .unwrap_or_default();
    let sep = std::path::MAIN_SEPARATOR;
    let from_target = dir.ends_with(&format!("{sep}target{sep}debug"))
        || dir.ends_with(&format!("{sep}target{sep}release"));
    let identifier = app.config().identifier.clone();
    let app_id = if from_target {
        Toast::POWERSHELL_APP_ID
    } else {
        &identifier
    };
    Toast::new(app_id)
        .title(title)
        .text1(body)
        .sound(None)
        .on_activated(move |_| {
            on_click();
            Ok(())
        })
        .show()
        .map_err(|e| e.to_string())
}

#[cfg(not(windows))]
pub fn show<R: Runtime>(
    app: &AppHandle<R>,
    title: &str,
    body: &str,
    _on_click: impl Fn() + Send + 'static,
) -> Result<(), String> {
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn el_texto_sale_plano_y_acotado() {
        assert_eq!(plain("  hola\n\tmundo \u{7} x ", 50), "hola mundo x");
        assert_eq!(plain("abcdef", 4), "abc…");
        assert_eq!(plain("ñañaña", 6), "ñañaña");
        assert_eq!(plain("\n\n", 10), "");
    }

    #[test]
    fn la_sesion_recordada_se_usa_una_vez_y_caduca() {
        let pending = PendingNotice::default();
        let t0 = Instant::now();
        pending.remember("ses_1".into(), t0);
        assert_eq!(
            pending.take_fresh(t0 + Duration::from_secs(5)),
            Some("ses_1".into())
        );
        assert_eq!(pending.take_fresh(t0 + Duration::from_secs(6)), None);

        pending.remember("ses_2".into(), t0);
        assert_eq!(
            pending.take_fresh(t0 + FOCUS_WINDOW + Duration::from_secs(1)),
            None
        );
        // La última sustituye a la anterior.
        pending.remember("a".into(), t0);
        pending.remember("b".into(), t0);
        assert_eq!(pending.take_fresh(t0), Some("b".into()));
    }
}
