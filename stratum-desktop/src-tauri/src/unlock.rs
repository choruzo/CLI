//! La ventana de desbloqueo: donde la persona teclea la clave de aprobador
//! **sin que la vea el webview principal**. Es la de Stratum Dot (`docs/dot.md`
//! §13) con el estado de Desktop:
//!
//! ```text
//! ventana «unlock»  ── POST desktop-unlock://localhost/submit (la clave) ──►  este fichero
//!  (otro origen,                                                              │
//!   sin IPC,                                                                  ▼
//!   página propia)                                             ApproverBroker::unlock(secret)
//! ```
//!
//!  - página **propia y estática** (`src-tauri/unlock/`), servida aquí con su
//!    CSP, en **otro origen** (`desktop-unlock`): no comparte almacenamiento ni
//!    nada con la principal;
//!  - **sin IPC**: no está en ninguna capacidad, así que no puede invocar ningún
//!    comando (lo garantiza el manifiesto de `build.rs`);
//!  - la clave llega con un `POST` a su propio origen, aceptado solo si viene
//!    **de la ventana `unlock`** (lo dice Tauri, no la petición) y con el `nonce`
//!    de la página servida;
//!  - la clave pasa a [`ApproverSecret`] (que se borra al soltarse) y de ahí al
//!    broker, que la escribe en el `core.hello` y la olvida.

use dot_link::ApproverSecret;
use std::sync::Mutex;
use tauri::http::{Request, Response, StatusCode};
use tauri::{AppHandle, Manager, Runtime, UriSchemeContext, UriSchemeResponder};

use crate::page::{forbidden, not_found, page_url, respond, BASE_STYLE, MAX_BODY};

/// Esquema propio de la página de desbloqueo.
pub const SCHEME: &str = "desktop-unlock";
/// Etiqueta de su ventana: la única de la que se acepta una clave.
pub const WINDOW: &str = "unlock";

const PAGE: &str = include_str!("../unlock/index.html");
const SCRIPT: &str = include_str!("../unlock/unlock.js");
const STYLE: &str = BASE_STYLE;

/// El `nonce` de la página servida ahora. `None`: no hay ventana de desbloqueo.
#[derive(Default)]
pub struct UnlockPrompt {
    nonce: Mutex<Option<String>>,
}

impl UnlockPrompt {
    fn current(&self) -> Option<String> {
        self.nonce.lock().ok().and_then(|n| n.clone())
    }

    fn set(&self, value: Option<String>) {
        if let Ok(mut nonce) = self.nonce.lock() {
            *nonce = value;
        }
    }

    /// La ventana se cerró: ya no se acepta nada.
    pub fn clear(&self) {
        self.set(None);
    }
}

/// 128 bits del generador del sistema operativo para atar la petición a la
/// página servida. Sin él no se abre la ventana (falla cerrado).
pub(crate) fn new_nonce() -> Option<String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).ok()?;
    Some(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

/// Abre la ventana de desbloqueo, o trae al frente la que ya hay. Solo la
/// pide la persona («Desbloquear»): nunca se abre sola.
pub fn open<R: Runtime>(app: &AppHandle<R>, prompt: &UnlockPrompt) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window(WINDOW) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        return Ok(());
    }
    let Some(nonce) = new_nonce() else {
        return Err(tauri::Error::AssetNotFound("no system randomness".into()));
    };
    prompt.set(Some(nonce));
    let mut builder = tauri::WebviewWindowBuilder::new(app, WINDOW, page_url(SCHEME))
        .title("Desbloquear aprobaciones — Stratum Desktop")
        .inner_size(440.0, 320.0)
        .resizable(false)
        .minimizable(false)
        .maximizable(false)
        .center()
        .focused(true)
        .always_on_top(true);
    if let Some(main) = app.get_webview_window("main") {
        builder = builder.parent(&main)?;
    }
    if let Err(error) = builder.build() {
        prompt.clear();
        return Err(error);
    }
    Ok(())
}

fn close_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window(WINDOW) {
        let _ = window.close();
    }
}

fn show_main<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn json(ok: bool, message: Option<&str>) -> Response<Vec<u8>> {
    crate::page::json(&match message {
        Some(message) => serde_json::json!({ "ok": ok, "message": message }),
        None => serde_json::json!({ "ok": ok }),
    })
}

/// Lo que se puede pedir al esquema `desktop-unlock`.
pub fn handle<R: Runtime>(
    ctx: UriSchemeContext<'_, R>,
    request: Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    let app = ctx.app_handle().clone();
    let Some(state) = app.try_state::<crate::DesktopState>() else {
        return responder.respond(not_found());
    };
    // Quien pide lo dice Tauri: otra ventana (la principal) no recibe ni envía nada aquí.
    if ctx.webview_label() != WINDOW {
        state
            .logger
            .warn("unlock: request from another window refused");
        return responder.respond(forbidden());
    }
    let prompt = &state.prompt;
    let Some(nonce) = prompt.current() else {
        return responder.respond(not_found());
    };
    let path = request.uri().path().to_string();
    let method = request.method().clone();

    if method == tauri::http::Method::GET {
        let response = match path.as_str() {
            "/" | "/index.html" => {
                let minutes = dot_link::approver::ApproverTimings::default()
                    .unlocked_for
                    .as_secs()
                    / 60;
                let page = PAGE
                    .replace("{{NONCE}}", &nonce)
                    .replace("{{MINUTES}}", &minutes.to_string());
                respond(
                    StatusCode::OK,
                    "text/html; charset=utf-8",
                    page.into_bytes(),
                )
            }
            "/unlock.js" => respond(
                StatusCode::OK,
                "text/javascript; charset=utf-8",
                SCRIPT.as_bytes().to_vec(),
            ),
            "/unlock.css" => respond(
                StatusCode::OK,
                "text/css; charset=utf-8",
                STYLE.as_bytes().to_vec(),
            ),
            _ => not_found(),
        };
        return responder.respond(response);
    }

    let presented = request
        .headers()
        .get("x-desktop-unlock")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    if method != tauri::http::Method::POST || presented.as_deref() != Some(nonce.as_str()) {
        return responder.respond(not_found());
    }
    match path.as_str() {
        "/cancel" => {
            prompt.clear();
            // Cancelar a mitad de la comprobación no deja nada desbloqueado.
            if matches!(state.broker.status(), dot_link::ApproverStatus::Unlocking) {
                state.broker.lock();
            }
            close_window(&app);
            responder.respond(json(true, None));
        }
        "/submit" => {
            let body = request.into_body();
            if body.len() > MAX_BODY {
                let _ = ApproverSecret::from_bytes(body);
                return responder.respond(json(false, Some(UNLOCK_FAILED)));
            }
            let secret = match ApproverSecret::from_bytes(body) {
                Ok(secret) => secret,
                Err(_) => {
                    return responder.respond(json(false, Some("Escribe la clave de aprobador.")));
                }
            };
            let broker = state.broker.clone();
            tauri::async_runtime::spawn(async move {
                match broker.unlock(secret).await {
                    Ok(()) => {
                        // Si la persona cerró la ventana mientras tanto, no se da por desbloqueado.
                        let still_open =
                            app.try_state::<crate::DesktopState>().is_some_and(|state| {
                                state.prompt.current().as_deref() == Some(nonce.as_str())
                            });
                        if !still_open {
                            broker.lock();
                            responder.respond(json(false, Some("Se canceló el desbloqueo.")));
                            return;
                        }
                        if let Some(state) = app.try_state::<crate::DesktopState>() {
                            state.prompt.clear();
                        }
                        responder.respond(json(true, None));
                        close_window(&app);
                        show_main(&app);
                    }
                    // El broker ya da un motivo genérico para la clave; aquí solo se traduce.
                    Err(error) => responder.respond(json(false, Some(&unlock_message(&error)))),
                }
            });
        }
        _ => responder.respond(not_found()),
    }
}

/// Lo que se dice de una clave que el daemon no acepta: nada más (ni si había
/// clave, ni si no coincidía). Es el `UNLOCK_FAILED` del broker, en español.
const UNLOCK_FAILED: &str = "No se pudo desbloquear. Comprueba la clave de aprobador.";

/// Los motivos del broker (`dot_link::approver`, en inglés y compartido con
/// Dot) en palabras de Desktop. Uno que no se conoce se dice genérico: el
/// detalle está en el log del enlace.
fn unlock_message(error: &dot_link::CommandError) -> String {
    match error.message.as_str() {
        "Wait a moment before trying again." => {
            "Espera un momento antes de volver a intentarlo.".into()
        }
        "Already unlocking." => "Ya se está comprobando una clave.".into(),
        "Not connected to the Stratum daemon." => {
            "Sin conexión con el daemon de Stratum.".into()
        }
        "The Stratum daemon is not answering." => "El daemon de Stratum no responde.".into(),
        "The Stratum daemon does not accept remote approvals: no approver key is configured." => {
            "El daemon no acepta aprobadores: fija una clave con `stratum approvals set-key`.".into()
        }
        _ if error.message.starts_with("Could not verify") => {
            "No se pudo comprobar que quien responde es el daemon de Stratum. La clave no se ha enviado.".into()
        }
        _ => UNLOCK_FAILED.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cada_nonce_es_otro() {
        let a = new_nonce().unwrap();
        let b = new_nonce().unwrap();
        assert_eq!(a.len(), 32);
        assert_ne!(a, b);
    }

    #[test]
    fn los_motivos_del_broker_se_traducen_y_la_clave_mala_no_dice_mas() {
        use dot_link::{CommandError, CommandErrorKind};
        let wait = CommandError::new(
            CommandErrorKind::NotSent,
            "Wait a moment before trying again.",
        );
        assert!(unlock_message(&wait).starts_with("Espera un momento"));
        let bad = CommandError::new(
            CommandErrorKind::Rejected,
            dot_link::approver::UNLOCK_FAILED,
        );
        assert_eq!(unlock_message(&bad), UNLOCK_FAILED);
        let other = CommandError::new(CommandErrorKind::NotSent, "something new");
        assert_eq!(unlock_message(&other), UNLOCK_FAILED);
    }

    #[test]
    fn la_pagina_no_trae_nada_de_fuera() {
        for asset in [PAGE, SCRIPT, STYLE] {
            assert!(!asset.contains("http://") && !asset.contains("https://"));
            // Sin almacenamiento ni IPC de Tauri.
            for banned in [
                "localStorage",
                "sessionStorage",
                "indexedDB",
                "document.cookie",
                "__TAURI",
                "invoke(",
                "innerHTML",
            ] {
                assert!(!asset.contains(banned), "{banned}");
            }
        }
        assert!(PAGE.contains(r#"type="password""#));
        assert!(PAGE.contains("{{NONCE}}"));
    }
}
