//! La ventana de **confirmación nativa** (M9): donde la persona confirma una
//! resolución sensible **sin que el webview principal pueda hacerlo por ella**.
//!
//! ```text
//! webview principal ── dot_approve(id) ──► commands.rs ──► ConfirmGate::request
//!                                                              │ (lee del daemon qué es)
//!                                                              ▼
//! ventana «confirm-N» ◄── TauriPresenter::show ── página propia, otro origen, sin IPC
//!   │ GET /view (lo que dijo el daemon)
//!   │ POST /confirm (y la frase, si la pide)
//!   ▼
//! este fichero ── ConfirmGate::confirm ──► ConfirmedAction ──► broker ──► stratumd
//! ```
//!
//! Por qué una ventana propia y no un diálogo del sistema: los diálogos de
//! mensaje no tienen campo de texto (una confirmación con nombre exige
//! teclear la frase) y no se pueden automatizar en un E2E. Esta ventana tiene
//! las mismas garantías que la de desbloqueo (`unlock.rs`):
//!
//!  - página **propia y estática**, servida aquí con su CSP, en **otro origen**
//!    (`dot-confirm`): no comparte nada con la principal;
//!  - **sin IPC**: no está en ninguna capacidad, no invoca ningún `dot_*`;
//!  - solo se atiende lo que viene de **su** ventana (lo dice Tauri, no la
//!    petición: `webview_label`) y con el `nonce` de la confirmación abierta;
//!  - lo que enseña no lo dice el webview: lo leyó [`dot_link::ConfirmGate`]
//!    del daemon, y la página lo pinta con `textContent` (nunca HTML).
//!
//! Cada confirmación tiene su ventana (`confirm-N`): así el cierre tardío de
//! una anterior no cancela la siguiente.

use dot_link::{ConfirmGate, Presenter};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::http::{Request, StatusCode};
use tauri::{AppHandle, Manager, Runtime, UriSchemeContext, UriSchemeResponder, WebviewUrl};

use crate::page::{forbidden, json, not_found, respond, BASE_STYLE, MAX_BODY};

/// Esquema propio de la página de confirmación.
pub const SCHEME: &str = "dot-confirm";
/// Prefijo de la etiqueta de sus ventanas.
pub const WINDOW_PREFIX: &str = "confirm-";

const PAGE: &str = include_str!("../confirm/index.html");
const SCRIPT: &str = include_str!("../confirm/confirm.js");
const STYLE: &str = include_str!("../confirm/confirm.css");

/// Qué ventana enseña qué confirmación. Una a la vez, pero una ventana que se
/// cierra puede avisar tarde: por eso cada una lleva su etiqueta.
#[derive(Default)]
pub struct ConfirmWindows {
    by_label: Mutex<HashMap<String, String>>,
    next: AtomicU64,
}

impl ConfirmWindows {
    fn nonce_of(&self, label: &str) -> Option<String> {
        self.by_label.lock().ok()?.get(label).cloned()
    }

    fn register(&self, nonce: &str) -> String {
        let label = format!(
            "{WINDOW_PREFIX}{}",
            self.next.fetch_add(1, Ordering::Relaxed) + 1
        );
        if let Ok(mut map) = self.by_label.lock() {
            map.insert(label.clone(), nonce.to_string());
        }
        label
    }

    /// La ventana `label` se cerró: deja de atenderse, y lo que enseñaba se cancela.
    pub fn closed(&self, label: &str, gate: &ConfirmGate) {
        let nonce = self.by_label.lock().ok().and_then(|mut m| m.remove(label));
        if let Some(nonce) = nonce {
            gate.cancel(&nonce);
        }
    }

    fn labels_for(&self, nonce: &str) -> Vec<String> {
        self.by_label
            .lock()
            .map(|m| {
                m.iter()
                    .filter(|(_, n)| n.as_str() == nonce)
                    .map(|(l, _)| l.clone())
                    .collect()
            })
            .unwrap_or_default()
    }
}

fn page_url() -> WebviewUrl {
    #[cfg(windows)]
    let url = format!("http://{SCHEME}.localhost/");
    #[cfg(not(windows))]
    let url = format!("{SCHEME}://localhost/");
    WebviewUrl::CustomProtocol(url.parse().expect("valid confirm URL"))
}

/// Enseña cada confirmación en su ventana nativa. Una por petición.
pub struct TauriPresenter<R: Runtime> {
    app: AppHandle<R>,
    windows: Arc<ConfirmWindows>,
    nonce: Mutex<Option<String>>,
}

impl<R: Runtime> TauriPresenter<R> {
    pub fn new(app: AppHandle<R>, windows: Arc<ConfirmWindows>) -> Self {
        Self {
            app,
            windows,
            nonce: Mutex::new(None),
        }
    }
}

impl<R: Runtime> Presenter for TauriPresenter<R> {
    fn show(&self, nonce: &str) -> Result<(), String> {
        let label = self.windows.register(nonce);
        if let Ok(mut current) = self.nonce.lock() {
            *current = Some(nonce.to_string());
        }
        let mut builder = tauri::WebviewWindowBuilder::new(&self.app, &label, page_url())
            .title("Confirm — Stratum Dot")
            .inner_size(480.0, 560.0)
            .min_inner_size(360.0, 360.0)
            .minimizable(false)
            .maximizable(false)
            .center()
            .focused(true)
            .always_on_top(true);
        if let Some(main) = self.app.get_webview_window("main") {
            builder = builder.parent(&main).map_err(|e| e.to_string())?;
        }
        builder.build().map(|_| ()).map_err(|e| e.to_string())
    }

    fn close(&self) {
        let Some(nonce) = self.nonce.lock().ok().and_then(|n| n.clone()) else {
            return;
        };
        for label in self.windows.labels_for(&nonce) {
            if let Some(window) = self.app.get_webview_window(&label) {
                let _ = window.close();
            }
        }
    }
}

/// Lo que se puede pedir al esquema `dot-confirm`.
pub fn handle<R: Runtime>(
    ctx: UriSchemeContext<'_, R>,
    request: Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    let app = ctx.app_handle().clone();
    let Some(state) = app.try_state::<crate::DotState>() else {
        return responder.respond(not_found());
    };
    // Quien pide lo dice Tauri: la ventana principal (o cualquier otra) no recibe ni envía nada aquí.
    let label = ctx.webview_label().to_string();
    let Some(nonce) = state.confirm_windows.nonce_of(&label) else {
        state
            .logger
            .warn("confirm: request from another window refused");
        return responder.respond(forbidden());
    };
    // Y tiene que ser la confirmación abierta ahora, no una anterior.
    if state.confirm.current_nonce().as_deref() != Some(nonce.as_str()) {
        return responder.respond(not_found());
    }
    let path = request.uri().path().to_string();
    let method = request.method().clone();

    if method == tauri::http::Method::GET {
        let response = match path.as_str() {
            "/" | "/index.html" => {
                // Desde que se sirve la página empieza a contar la espera antes de poder confirmar.
                state.confirm.shown(&nonce);
                respond(
                    StatusCode::OK,
                    "text/html; charset=utf-8",
                    PAGE.replace("{{NONCE}}", &nonce).into_bytes(),
                )
            }
            "/confirm.js" => respond(
                StatusCode::OK,
                "text/javascript; charset=utf-8",
                SCRIPT.as_bytes().to_vec(),
            ),
            "/confirm.css" => respond(
                StatusCode::OK,
                "text/css; charset=utf-8",
                format!("{BASE_STYLE}\n{STYLE}").into_bytes(),
            ),
            _ => not_found(),
        };
        return responder.respond(response);
    }

    let presented = request
        .headers()
        .get("x-dot-confirm")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    if method != tauri::http::Method::POST || presented.as_deref() != Some(nonce.as_str()) {
        return responder.respond(not_found());
    }
    match path.as_str() {
        "/view" => match state.confirm.view(&nonce) {
            Some(view) => responder.respond(json(
                &serde_json::to_value(&view).unwrap_or(serde_json::Value::Null),
            )),
            None => responder.respond(not_found()),
        },
        "/cancel" => {
            state.confirm.cancel(&nonce);
            responder.respond(json(&serde_json::json!({ "ok": true })));
        }
        "/confirm" => {
            let body = request.into_body();
            if body.len() > MAX_BODY {
                return responder.respond(json(&serde_json::json!({
                    "ok": false, "keepOpen": true, "message": "The phrase is too long."
                })));
            }
            let phrase = String::from_utf8(body).ok().filter(|p| !p.is_empty());
            let (gate, link, broker) = (
                state.confirm.clone(),
                state.link.clone(),
                state.broker.clone(),
            );
            tauri::async_runtime::spawn(async move {
                let answer = match gate.confirm(&link, &broker, &nonce, phrase).await {
                    Ok(()) => serde_json::json!({ "ok": true }),
                    Err(failure) => serde_json::json!({
                        "ok": false, "keepOpen": failure.keep_open, "message": failure.message
                    }),
                };
                responder.respond(json(&answer));
            });
        }
        _ => responder.respond(not_found()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn la_pagina_no_trae_nada_de_fuera_ni_pinta_html() {
        for asset in [PAGE, SCRIPT, STYLE] {
            assert!(!asset.contains("http://") && !asset.contains("https://"));
            for banned in [
                "localStorage",
                "sessionStorage",
                "indexedDB",
                "document.cookie",
                "__TAURI",
                "invoke(",
                "innerHTML",
                "outerHTML",
                "insertAdjacentHTML",
                "document.write",
                "eval(",
            ] {
                assert!(!asset.contains(banned), "{banned}");
            }
        }
        assert!(PAGE.contains("{{NONCE}}"));
        // El foco inicial nunca está en confirmar.
        assert!(PAGE.contains(r#"id="cancel" autofocus"#));
    }

    #[test]
    fn cada_ventana_su_etiqueta_y_su_confirmacion() {
        let windows = ConfirmWindows::default();
        let a = windows.register("n1");
        let b = windows.register("n2");
        assert_ne!(a, b);
        assert!(a.starts_with(WINDOW_PREFIX));
        assert_eq!(windows.nonce_of(&a).as_deref(), Some("n1"));
        assert_eq!(windows.nonce_of("main"), None);
        assert_eq!(windows.nonce_of("unlock"), None);
        let gate = ConfirmGate::new(Default::default(), dot_link::Logger::none());
        windows.closed(&a, &gate);
        assert_eq!(windows.nonce_of(&a), None);
        assert_eq!(windows.nonce_of(&b).as_deref(), Some("n2"));
    }
}
