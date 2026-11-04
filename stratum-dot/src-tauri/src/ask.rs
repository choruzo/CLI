//! El Dot compacto (PRD de Dot §8.2): una ventana flotante para hablarle al
//! asistente sin abrir la principal.
//!
//! ```text
//! Ctrl+Alt+Space / bandeja ──► ventana «ask» ── POST dot-ask://localhost/send ──► este fichero
//!                               (otro origen,                                     │
//!                                sin IPC,                                         ▼
//!                                página propia)           `dot://event` { type: 'ask', text } a «main»
//!                                                         y la principal al frente
//! ```
//!
//! Como las de desbloqueo y confirmación, esta ventana carga una página
//! **propia y estática** (`src-tauri/ask/`) en su propio origen y **no tiene
//! IPC**: no está en ninguna capacidad, así que no puede invocar ningún comando
//! ni hablar con el daemon. Lo escrito sale por un `POST` a su propio origen,
//! que solo se acepta **de la ventana `ask`** (lo dice Tauri, no la petición) y
//! con el `nonce` de la página servida. Este lado no conoce los DTOs del
//! protocolo: entrega el texto a la ventana principal, que es la que lo envía al
//! asistente (un run, o steering si está trabajando). El texto no se registra.

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Mutex;
use tauri::http::{Request, Response, StatusCode};
use tauri::{
    AppHandle, Emitter, Manager, Runtime, UriSchemeContext, UriSchemeResponder, WebviewUrl,
    WindowEvent,
};

use crate::page::{forbidden, not_found, respond, BASE_STYLE};

/// Esquema propio de la página.
pub const SCHEME: &str = "dot-ask";
/// Etiqueta de su ventana: la única de la que se acepta un mensaje.
pub const WINDOW: &str = "ask";
/// El atajo global que la abre (o la cierra). Lo eligió el usuario.
pub const SHORTCUT: &str = "CommandOrControl+Alt+Space";

const PAGE: &str = include_str!("../ask/index.html");
const SCRIPT: &str = include_str!("../ask/ask.js");
const STYLE: &str = include_str!("../ask/ask.css");

/// Lo más que se acepta en el cuerpo de `/send` (UTF-8, en bytes). El tope en
/// caracteres es el de un mensaje (`MAX_INPUT_CHARS`), que lo vuelve a aplicar
/// quien lo envía.
const MAX_SEND_BYTES: usize = 64 * 1024;
/// Caracteres que deja escribir la página.
const MAX_ASK_CHARS: usize = 16_000;

/// El `nonce` de la página servida ahora, y lo que espera a la persona.
#[derive(Default)]
pub struct AskPrompt {
    nonce: Mutex<Option<String>>,
    /// Lo pendiente (aprobaciones, preguntas, planes) que enseña la interfaz.
    waiting: AtomicU32,
    /// La ventana ya tuvo el foco: perderlo después es cerrarla.
    focused: AtomicBool,
}

impl AskPrompt {
    fn current(&self) -> Option<String> {
        self.nonce.lock().ok().and_then(|n| n.clone())
    }

    fn set(&self, value: Option<String>) {
        if let Ok(mut nonce) = self.nonce.lock() {
            *nonce = value;
        }
    }

    /// La ventana se cerró: ya no se acepta nada de ella.
    pub fn clear(&self) {
        self.set(None);
        self.focused.store(false, Ordering::SeqCst);
    }

    /// Lo pendiente que enseña la interfaz (`dot_set_attention`).
    pub fn set_waiting(&self, total: u32) {
        self.waiting.store(total, Ordering::SeqCst);
    }
}

/// 128 bits del generador del sistema operativo. Sin él no se abre (falla cerrado).
fn new_nonce() -> Option<String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).ok()?;
    Some(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

/// En Windows (WebView2) los esquemas propios se sirven como `http://<esquema>.localhost`.
fn page_url() -> WebviewUrl {
    #[cfg(windows)]
    let url = format!("http://{SCHEME}.localhost/");
    #[cfg(not(windows))]
    let url = format!("{SCHEME}://localhost/");
    WebviewUrl::CustomProtocol(url.parse().expect("valid ask URL"))
}

/// El atajo y la bandeja: si está abierta se cierra; si no, se abre. Cada
/// apertura es una ventana y un `nonce` nuevos.
pub fn toggle<R: Runtime>(app: &AppHandle<R>) {
    if app.get_webview_window(WINDOW).is_some() {
        close(app);
        return;
    }
    if let Err(error) = open(app) {
        if let Some(state) = app.try_state::<crate::DotState>() {
            state
                .logger
                .warn(&format!("ask: window not opened ({error})"));
        }
    }
}

fn open<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let Some(state) = app.try_state::<crate::DotState>() else {
        return Ok(());
    };
    let Some(nonce) = new_nonce() else {
        return Err(tauri::Error::AssetNotFound("no system randomness".into()));
    };
    state.ask.clear();
    state.ask.set(Some(nonce));
    let built = tauri::WebviewWindowBuilder::new(app, WINDOW, page_url())
        .title("Ask your assistant — Stratum Dot")
        .inner_size(480.0, 150.0)
        .resizable(false)
        .minimizable(false)
        .maximizable(false)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .center()
        .focused(true)
        .build();
    match built {
        Ok(window) => {
            let _ = window.set_focus();
            Ok(())
        }
        Err(error) => {
            state.ask.clear();
            Err(error)
        }
    }
}

fn close<R: Runtime>(app: &AppHandle<R>) {
    if let Some(state) = app.try_state::<crate::DotState>() {
        state.ask.clear();
    }
    if let Some(window) = app.get_webview_window(WINDOW) {
        let _ = window.close();
    }
}

/// Lo que hace la ventana con sus eventos: perder el foco la cierra (como
/// `Esc`); cerrarse la descarta.
pub fn on_window_event<R: Runtime>(window: &tauri::Window<R>, event: &WindowEvent) {
    let Some(state) = window.try_state::<crate::DotState>() else {
        return;
    };
    match event {
        WindowEvent::Focused(true) => state.ask.focused.store(true, Ordering::SeqCst),
        // Solo tras haberlo tenido: al crearse puede llegar un «sin foco» primero.
        WindowEvent::Focused(false) if state.ask.focused.load(Ordering::SeqCst) => {
            close(window.app_handle());
        }
        WindowEvent::Destroyed => state.ask.clear(),
        _ => {}
    }
}

fn json(ok: bool, message: Option<&str>) -> Response<Vec<u8>> {
    crate::page::json(&match message {
        Some(message) => serde_json::json!({ "ok": ok, "message": message }),
        None => serde_json::json!({ "ok": ok }),
    })
}

/// Lo que se puede pedir al esquema `dot-ask`.
pub fn handle<R: Runtime>(
    ctx: UriSchemeContext<'_, R>,
    request: Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    let app = ctx.app_handle().clone();
    let Some(state) = app.try_state::<crate::DotState>() else {
        return responder.respond(not_found());
    };
    if ctx.webview_label() != WINDOW {
        state
            .logger
            .warn("ask: request from another window refused");
        return responder.respond(forbidden());
    }
    let Some(nonce) = state.ask.current() else {
        return responder.respond(not_found());
    };
    let path = request.uri().path().to_string();
    let method = request.method().clone();
    let presented = request
        .headers()
        .get("x-dot-ask")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    let authentic = presented.as_deref() == Some(nonce.as_str());

    if method == tauri::http::Method::GET {
        let response = match path.as_str() {
            "/" | "/index.html" => respond(
                StatusCode::OK,
                "text/html; charset=utf-8",
                PAGE.replace("{{NONCE}}", &nonce)
                    .replace("{{MAX_CHARS}}", &MAX_ASK_CHARS.to_string())
                    .into_bytes(),
            ),
            "/ask.js" => respond(
                StatusCode::OK,
                "text/javascript; charset=utf-8",
                SCRIPT.as_bytes().to_vec(),
            ),
            "/ask.css" => respond(
                StatusCode::OK,
                "text/css; charset=utf-8",
                STYLE.as_bytes().to_vec(),
            ),
            "/unlock.css" => respond(
                StatusCode::OK,
                "text/css; charset=utf-8",
                BASE_STYLE.as_bytes().to_vec(),
            ),
            // Solo un número: cuánto espera a la persona.
            "/status" if authentic => crate::page::json(
                &serde_json::json!({ "waiting": state.ask.waiting.load(Ordering::SeqCst) }),
            ),
            _ => not_found(),
        };
        return responder.respond(response);
    }

    if method != tauri::http::Method::POST || !authentic {
        return responder.respond(not_found());
    }
    match path.as_str() {
        "/dismiss" => {
            close(&app);
            responder.respond(json(true, None));
        }
        "/send" => {
            let body = request.into_body();
            let text = match checked_text(body) {
                Ok(text) => text,
                Err(message) => return responder.respond(json(false, Some(message))),
            };
            // Sin el texto en el log: solo que se entregó.
            state.logger.info("ask: message handed to the main window");
            let _ = app.emit_to(
                "main",
                crate::DOT_EVENT,
                serde_json::json!({ "type": "ask", "text": text }),
            );
            responder.respond(json(true, None));
            close(&app);
            crate::show_main(&app);
        }
        _ => responder.respond(not_found()),
    }
}

/// El texto de `/send`, o por qué no vale. No se recorta: o cabe o no se envía.
fn checked_text(body: Vec<u8>) -> Result<String, &'static str> {
    if body.len() > MAX_SEND_BYTES {
        return Err("The message is too long.");
    }
    let text = String::from_utf8(body).map_err(|_| "The message could not be read.")?;
    if text.trim().is_empty() {
        return Err("Type something for your assistant.");
    }
    if text.chars().count() > MAX_ASK_CHARS {
        return Err("The message is too long.");
    }
    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn la_pagina_no_trae_nada_de_fuera_ni_ipc() {
        for source in [PAGE, SCRIPT] {
            assert!(!source.contains("http://") && !source.contains("https://"));
            assert!(!source.contains("__TAURI"));
            assert!(!source.contains("invoke"));
        }
        assert!(PAGE.contains("{{NONCE}}"));
    }

    #[test]
    fn el_texto_se_valida_entero_sin_recortar() {
        assert_eq!(checked_text(b"hola".to_vec()).unwrap(), "hola");
        assert!(checked_text(b"   \n".to_vec()).is_err());
        assert!(checked_text(vec![0xff, 0xfe]).is_err());
        assert!(checked_text("x".repeat(MAX_ASK_CHARS + 1).into_bytes()).is_err());
        assert!(checked_text(vec![b'x'; MAX_SEND_BYTES + 1]).is_err());
        assert_eq!(
            checked_text("ñ".repeat(MAX_ASK_CHARS).into_bytes())
                .unwrap()
                .chars()
                .count(),
            MAX_ASK_CHARS
        );
    }

    #[test]
    fn cada_nonce_es_otro() {
        assert_ne!(new_nonce(), new_nonce());
    }
}
