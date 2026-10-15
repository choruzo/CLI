//! La ventana de desbloqueo: donde la persona teclea la clave de aprobador
//! **sin que la vea el webview principal**.
//!
//! ```text
//! ventana «unlock»  ── POST dot-unlock://localhost/submit (la clave) ──►  este fichero
//!  (otro origen,                                                          │
//!   sin IPC,                                                              ▼
//!   página propia)                                         ApproverBroker::unlock(secret)
//! ```
//!
//! Por qué así: Tauri no ofrece un diálogo nativo con campo de texto, y un
//! `<input>` en la ventana principal pondría la clave en el mismo JS que pinta
//! lo que escribe un modelo. Esta ventana:
//!
//!  - carga una página **propia y estática** (`src-tauri/unlock/`), servida
//!    aquí con su CSP, en **otro origen** (`dot-unlock`): no comparte
//!    almacenamiento, service workers ni nada con la principal;
//!  - **no tiene IPC**: no está en ninguna capacidad, así que no puede invocar
//!    ningún comando `dot_*` (lo garantiza el manifiesto de `build.rs`);
//!  - entrega la clave con un `POST` a su propio origen, que atiende este
//!    manejador. Solo se acepta si viene **de la ventana `unlock`** (lo dice
//!    Tauri, no la petición) y con el `nonce` de la página servida;
//!  - la clave pasa a [`ApproverSecret`] (que se borra al soltarse) y de ahí al
//!    broker, que la escribe en el `core.hello` y la olvida.
//!
//! Lo que esto **no** cierra está en `docs/dot.md` §13: un proceso del mismo
//! usuario sigue dentro del mismo dominio de confianza.

use dot_link::ApproverSecret;
use std::sync::Mutex;
use tauri::http::{header, Request, Response, StatusCode};
use tauri::{AppHandle, Manager, Runtime, UriSchemeContext, UriSchemeResponder, WebviewUrl};

/// Esquema propio de la página de desbloqueo.
pub const SCHEME: &str = "dot-unlock";
/// Etiqueta de su ventana: la única de la que se acepta una clave.
pub const WINDOW: &str = "unlock";

const PAGE: &str = include_str!("../unlock/index.html");
const SCRIPT: &str = include_str!("../unlock/unlock.js");
const STYLE: &str = include_str!("../unlock/unlock.css");

/// Lo más que se acepta en el cuerpo: la clave (1 024 caracteres) en UTF-8.
const MAX_BODY: usize = 4 * 1024;

const CSP: &str = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; \
     img-src 'none'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'";

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
fn new_nonce() -> Option<String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).ok()?;
    Some(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

/// Dirección de la página: en Windows (WebView2) los esquemas propios se sirven
/// como `http://<esquema>.localhost`.
fn page_url() -> WebviewUrl {
    #[cfg(windows)]
    let url = format!("http://{SCHEME}.localhost/");
    #[cfg(not(windows))]
    let url = format!("{SCHEME}://localhost/");
    WebviewUrl::CustomProtocol(url.parse().expect("valid unlock URL"))
}

/// Abre la ventana de desbloqueo, o trae al frente la que ya hay. Solo la
/// pide la persona (*Unlock approvals*): nunca se abre sola.
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
    let mut builder = tauri::WebviewWindowBuilder::new(app, WINDOW, page_url())
        .title("Unlock approvals — Stratum Dot")
        .inner_size(420.0, 300.0)
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

fn respond(status: StatusCode, content_type: &str, body: Vec<u8>) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, content_type)
        .header(header::CONTENT_SECURITY_POLICY, CSP)
        .header(header::CACHE_CONTROL, "no-store")
        .header("X-Content-Type-Options", "nosniff")
        .header("Referrer-Policy", "no-referrer")
        .body(body)
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

fn json(ok: bool, message: Option<&str>) -> Response<Vec<u8>> {
    let body = match message {
        Some(message) => serde_json::json!({ "ok": ok, "message": message }),
        None => serde_json::json!({ "ok": ok }),
    };
    respond(
        StatusCode::OK,
        "application/json",
        body.to_string().into_bytes(),
    )
}

fn not_found() -> Response<Vec<u8>> {
    respond(StatusCode::NOT_FOUND, "text/plain", b"not found".to_vec())
}

/// Lo que se puede pedir al esquema `dot-unlock`.
pub fn handle<R: Runtime>(
    ctx: UriSchemeContext<'_, R>,
    request: Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    let app = ctx.app_handle().clone();
    // Quien pide lo dice Tauri: otra ventana (la principal) no recibe ni envía nada aquí.
    let Some(state) = app.try_state::<crate::DotState>() else {
        return responder.respond(not_found());
    };
    if ctx.webview_label() != WINDOW {
        state
            .logger
            .warn("unlock: request from another window refused");
        return responder.respond(respond(
            StatusCode::FORBIDDEN,
            "text/plain",
            b"forbidden".to_vec(),
        ));
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
        .get("x-dot-unlock")
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
                return responder.respond(json(false, Some(dot_link::approver::UNLOCK_FAILED)));
            }
            let secret = match ApproverSecret::from_bytes(body) {
                Ok(secret) => secret,
                Err(_) => {
                    return responder.respond(json(false, Some("Type the approver key.")));
                }
            };
            let broker = state.broker.clone();
            tauri::async_runtime::spawn(async move {
                match broker.unlock(secret).await {
                    Ok(()) => {
                        // Si la persona cerró la ventana mientras tanto, no se da por desbloqueado.
                        let still_open = app.try_state::<crate::DotState>().is_some_and(|state| {
                            state.prompt.current().as_deref() == Some(nonce.as_str())
                        });
                        if !still_open {
                            broker.lock();
                            responder.respond(json(false, Some("The unlock was cancelled.")));
                            return;
                        }
                        if let Some(state) = app.try_state::<crate::DotState>() {
                            state.prompt.clear();
                        }
                        responder.respond(json(true, None));
                        close_window(&app);
                        crate::show_main(&app);
                    }
                    // El motivo es genérico (lo da el broker): no se dice más.
                    Err(error) => responder.respond(json(false, Some(&error.message))),
                }
            });
        }
        _ => responder.respond(not_found()),
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
            ] {
                assert!(!asset.contains(banned), "{banned}");
            }
        }
        assert!(PAGE.contains(r#"type="password""#));
        assert!(PAGE.contains("{{NONCE}}"));
    }
}
