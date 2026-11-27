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
//! Desde M25 fase 4 (parte 3) el atajo **se mantiene** ([`crate::hold`]): un
//! toque abre (o cierra) esta ventana como siempre; mantenerlo 300 ms la abre en
//! «Listening…» y graba del micrófono hasta soltarlo. Lo grabado no pasa por
//! aquí: lo lleva [`crate::voice`], que lo sube al daemon y recibe el texto. Esta
//! ventana solo pregunta cómo va (`GET /voice`) y lo enseña:
//!
//! ```text
//! atajo ──► voice.rs ──voice.*──► stratumd ──texto──► AskPrompt.voice ──GET /voice──► página
//! ```
//!
//! Como las de desbloqueo y confirmación, esta ventana carga una página
//! **propia y estática** (`src-tauri/ask/`) en su propio origen y **no tiene
//! IPC**: no está en ninguna capacidad, así que no puede invocar ningún comando
//! ni hablar con el daemon. Lo escrito sale por un `POST` a su propio origen,
//! que solo se acepta **de la ventana `ask`** (lo dice Tauri, no la petición) y
//! con el `nonce` de la página servida. Este lado no conoce los DTOs del
//! protocolo: entrega el texto a la ventana principal, que es la que lo envía al
//! asistente (un run, o steering si está trabajando). El texto no se registra, y
//! el audio no llega aquí en ningún momento.

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Mutex, MutexGuard};
use std::time::Instant;
use tauri::http::{Request, Response, StatusCode};
use tauri::{
    AppHandle, Emitter, Manager, Runtime, UriSchemeContext, UriSchemeResponder, WebviewUrl,
    WindowEvent,
};

use crate::hold::{Action, Hold};
use crate::page::{forbidden, not_found, respond, BASE_STYLE};
use crate::voice::{Origin, Progress};
use serde_json::Value;

/// Esquema propio de la página.
pub const SCHEME: &str = "dot-ask";
/// Etiqueta de su ventana: la única de la que se acepta un mensaje.
pub const WINDOW: &str = "ask";
/// El atajo global que la abre (o la cierra), y que mantenido graba una nota.
pub const SHORTCUT: &str = "CommandOrControl+Alt+Space";

const PAGE: &str = include_str!("../ask/index.html");
const SCRIPT: &str = include_str!("../ask/ask.js");
const STYLE: &str = include_str!("../ask/ask.css");

/// Lo más que se acepta en el cuerpo de `/send` (UTF-8, en bytes). El tope en
/// caracteres es el de un mensaje (`MAX_INPUT_CHARS`), que lo vuelve a aplicar
/// quien lo envía.
const MAX_SEND_BYTES: usize = 64 * 1024;
/// Caracteres que deja escribir la página, y tope del texto de una nota.
const MAX_ASK_CHARS: usize = 16_000;

/// Candado de un `Mutex` que no se envenena: aquí no hay estado a medio escribir.
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poison| poison.into_inner())
}

/// Lo que la página enseña de la nota del atajo (PRD §M25 fase 4, parte 3).
/// Mientras se escucha, los segundos y el nivel los lleva la grabación: aquí solo
/// se guarda cuál es el estado.
#[derive(Debug, Clone, PartialEq)]
enum VoiceView {
    /// Nada en curso (es donde se queda tras `POST /voice/ack`).
    Idle,
    /// Grabando: cuánto lleva y el nivel de lo último capturado.
    Listening { seconds: u64, level: Option<f32> },
    /// Soltó y el daemon está transcribiendo.
    Transcribing,
    /// Ya hay texto: la página lo pone en el campo y avisa de que lo leyó.
    Done {
        text: String,
        duration_sec: f64,
        capped: bool,
    },
    /// No hubo nota: el motivo, en algo que se pueda leer.
    Error { message: String },
}

impl VoiceView {
    /// ¿Hay una nota en curso? Mientras la hay, el compacto **no** se cierra al
    /// perder el foco.
    fn busy(&self) -> bool {
        matches!(self, VoiceView::Listening { .. } | VoiceView::Transcribing)
    }
}

/// El `nonce` de la página servida ahora, lo que espera a la persona y cómo va
/// la nota del atajo.
pub struct AskPrompt {
    nonce: Mutex<Option<String>>,
    /// Lo pendiente (aprobaciones, preguntas, planes) que enseña la interfaz.
    waiting: AtomicU32,
    /// La ventana ya tuvo el foco: perderlo después es cerrarla.
    focused: AtomicBool,
    /// La voz del compacto (M25 fase 4, parte 3).
    voice: Mutex<VoiceView>,
    /// El atajo: armado, hablando o en reposo (`crate::hold`).
    hold: Mutex<Hold>,
    /// Las transiciones de la nota del atajo, una detrás de otra: soltar nunca
    /// puede adelantarse al arranque que aún está abriendo el micrófono.
    talk: tokio::sync::Mutex<()>,
}

impl Default for AskPrompt {
    fn default() -> Self {
        Self {
            nonce: Mutex::new(None),
            waiting: AtomicU32::new(0),
            focused: AtomicBool::new(false),
            voice: Mutex::new(VoiceView::Idle),
            hold: Mutex::new(Hold::default()),
            talk: tokio::sync::Mutex::new(()),
        }
    }
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

    /// La ventana se cerró: lo que tuviera en curso ya no tiene dónde ir.
    pub fn reset(&self) {
        self.clear();
        self.set_voice(VoiceView::Idle);
        lock(&self.hold).reset();
    }

    // ------------------------------------------------------------ la voz

    fn set_voice(&self, view: VoiceView) {
        *lock(&self.voice) = view;
    }

    /// La página ya leyó lo que había.
    /// Vuelve a `idle` solo desde `listening`: nunca pisa un error ni un texto.
    fn clear_listening(&self) {
        let mut view = lock(&self.voice);
        if matches!(*view, VoiceView::Listening { .. }) {
            *view = VoiceView::Idle;
        }
    }

    fn ack(&self) {
        self.set_voice(VoiceView::Idle);
    }

    /// Lo que se le contesta a `GET /voice`, con los segundos y el nivel al día
    /// mientras se escucha (los lleva la grabación, no este lado).
    fn view(&self, progress: Option<Progress>) -> VoiceView {
        let mut view = lock(&self.voice);
        if let VoiceView::Listening { seconds, level } = &mut *view {
            if let Some(progress) = progress {
                *seconds = progress.seconds;
                // Sin nivel todavía (aún no llegó ninguna muestra) se queda el
                // último: la barra no baja de golpe.
                *level = progress.level.or(*level);
            }
        }
        view.clone()
    }

    /// Ya hay texto (o un motivo): se guarda solo si el compacto sigue
    /// esperándolo. Si se cerró mientras transcribía, el texto se descarta.
    fn finish_voice(&self, view: VoiceView) {
        let mut current = lock(&self.voice);
        if matches!(*current, VoiceView::Transcribing) {
            *current = view;
        }
    }

    fn voice_busy(&self) -> bool {
        lock(&self.voice).busy()
    }

    // ----------------------------------------------------------- el atajo

    fn pressed(&self, at: Instant) -> Option<Instant> {
        lock(&self.hold).pressed(at)
    }

    fn released(&self, at: Instant) -> Option<Action> {
        lock(&self.hold).released(at)
    }

    fn expired(&self, at: Instant) -> Option<Action> {
        lock(&self.hold).expired(at)
    }

    /// La tecla sigue abajo y ya se graba.
    fn is_talking(&self) -> bool {
        lock(&self.hold).is_talking()
    }

    fn reset_hold(&self) {
        lock(&self.hold).reset();
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

/// El atajo y la bandeja, **sin mantener**: si está abierta se cierra; si no, se
/// abre. Cada apertura es una ventana y un `nonce` nuevos.
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
        .inner_size(480.0, 176.0)
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

/// La ventana del compacto delante: la que ya hay (con su `nonce`, para que la
/// página siga valiendo) o una nueva.
fn show_compact<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    match app.get_webview_window(WINDOW) {
        Some(window) => {
            let _ = window.show();
            let _ = window.set_focus();
            Ok(())
        }
        None => open(app),
    }
}

fn close<R: Runtime>(app: &AppHandle<R>) {
    if let Some(state) = app.try_state::<crate::DotState>() {
        state.ask.clear();
        // Se cierra el compacto: no queda nada que enseñar de la nota.
        state.ask.set_voice(VoiceView::Idle);
    }
    if let Some(window) = app.get_webview_window(WINDOW) {
        let _ = window.close();
    }
}

// ---------------------------------------------------------------- el atajo

/// La tecla del atajo: `pressed` al bajarla y al subirla (M25 fase 4, parte 3).
/// La decisión es de [`crate::hold`] y se toma **al llegar el evento**; lo que
/// tarda (abrir el micrófono, transcribir) va después, en su turno.
pub fn on_shortcut<R: Runtime>(app: &AppHandle<R>, pressed: bool) {
    let Some(state) = app.try_state::<crate::DotState>() else {
        return;
    };
    if pressed {
        // La autorrepetición del sistema operativo no arma un plazo nuevo.
        let Some(deadline) = state.ask.pressed(Instant::now()) else {
            return;
        };
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(deadline.saturating_duration_since(Instant::now())).await;
            held(&app).await;
        });
        return;
    }
    let action = state.ask.released(Instant::now());
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let Some(state) = app.try_state::<crate::DotState>() else {
            return;
        };
        match action {
            Some(Action::Tap) => toggle(&app),
            Some(Action::Stop) => {
                let _turn = state.ask.talk.lock().await;
                stop_note(&state).await;
            }
            Some(Action::Talk) | None => {}
        }
    });
}

/// Venció el plazo y la tecla sigue abajo: a hablar.
async fn held<R: Runtime>(app: &AppHandle<R>) {
    let Some(state) = app.try_state::<crate::DotState>() else {
        return;
    };
    if state.ask.expired(Instant::now()) != Some(Action::Talk) {
        return;
    }
    let _turn = state.ask.talk.lock().await;
    // Mientras esperaba el turno pudo soltarse (o cerrarse el compacto): si ya
    // no está hablando, esta nota no llega a existir.
    if !state.ask.is_talking() {
        return;
    }
    start_note(app, &state).await;
}

/// Abre el compacto (o reutiliza el que ya está) y empieza a grabar la nota del
/// asistente. El atajo no pasa por el webview: aquí no hay nadie a quien pedir
/// permiso, y por eso la nota es siempre de la sesión del asistente.
async fn start_note<R: Runtime>(app: &AppHandle<R>, state: &crate::DotState) {
    // Una nota a la vez: si el botón del chat ya está grabando, el atajo no
    // empieza otra (ni abre el compacto para nada).
    if state.voice.is_recording() {
        state
            .logger
            .info("ask: the shortcut found a note in progress");
        state.ask.reset_hold();
        return;
    }
    // Mientras se transcribe no se empieza otra: el texto de la anterior aún no
    // está en el campo.
    if state.ask.voice_busy() {
        state.ask.reset_hold();
        return;
    }
    // La página puede preguntar nada más cargar: se apunta antes de abrirla.
    state.ask.set_voice(VoiceView::Listening {
        seconds: 0,
        level: None,
    });
    if let Err(error) = show_compact(app) {
        state
            .logger
            .warn(&format!("ask: window not opened ({error})"));
        state.ask.set_voice(VoiceView::Error {
            message: "The compact window could not open.".to_string(),
        });
        state.ask.reset_hold();
        return;
    }
    if let Err(error) = state.voice.start_companion().await {
        // El audio (lo poco que hubiera) se tira dentro; aquí solo se dice por qué.
        state.ask.set_voice(VoiceView::Error {
            message: explain(&error.message),
        });
        state.ask.reset_hold();
    }
}

/// Soltó tras hablar: parar el micrófono y transcribir. El texto se queda en la
/// página; no se registra en ningún sitio.
async fn stop_note(state: &crate::DotState) {
    // Solo la del atajo: si la nota en curso la empezó la ventana principal, no
    // se toca (su dueño es el botón del chat).
    if state.voice.origin() != Some(Origin::Shortcut) {
        // Sin nota del atajo (no llegó a arrancar): solo se limpia el «escuchando».
        // Un error del arranque se queda para que la página lo enseñe.
        state.ask.clear_listening();
        return;
    }
    state.ask.set_voice(VoiceView::Transcribing);
    let view = match state.voice.stop().await {
        Ok(result) => done_from(&result),
        Err(error) => VoiceView::Error {
            message: explain(&error.message),
        },
    };
    state.ask.finish_voice(view);
}

/// Tira la nota del atajo sin hacer esperar a la página (`/voice/cancel`, `Esc`).
fn cancel_note<R: Runtime>(app: AppHandle<R>) {
    tauri::async_runtime::spawn(async move {
        let Some(state) = app.try_state::<crate::DotState>() else {
            return;
        };
        if state.voice.origin() != Some(Origin::Shortcut) {
            return;
        }
        if state.voice.cancel().await.is_err() {
            state.logger.warn("ask: the note could not be dropped");
        }
    });
}

// ------------------------------------------------------------- lo que se pide

fn json(ok: bool, message: Option<&str>) -> Response<Vec<u8>> {
    crate::page::json(&match message {
        Some(message) => serde_json::json!({ "ok": ok, "message": message }),
        None => serde_json::json!({ "ok": ok }),
    })
}

/// Lo que contesta un `GET` con el `nonce` de la página: lo que espera a la
/// persona y cómo va la nota. `None` es «aquí no hay nada» (404). Puro: los
/// tests lo llaman sin Tauri.
fn state_json(path: &str, authentic: bool, waiting: u32, view: &VoiceView) -> Option<Value> {
    if !authentic {
        return None;
    }
    match path {
        // Solo un número: cuánto espera a la persona.
        "/status" => Some(serde_json::json!({ "waiting": waiting })),
        "/voice" => Some(voice_json(view)),
        _ => None,
    }
}

/// La nota en JSON, tal como la lee `ask.js`. Del audio, solo el nivel.
fn voice_json(view: &VoiceView) -> Value {
    match view {
        VoiceView::Idle => serde_json::json!({ "state": "idle" }),
        VoiceView::Listening { seconds, level } => serde_json::json!({
            "state": "listening",
            "seconds": seconds,
            // `null` mientras no haya llegado ninguna muestra.
            "level": level,
        }),
        VoiceView::Transcribing => serde_json::json!({ "state": "transcribing" }),
        VoiceView::Done {
            text,
            duration_sec,
            capped,
        } => serde_json::json!({
            "state": "done",
            "text": text,
            "durationSec": duration_sec,
            "capped": capped,
        }),
        VoiceView::Error { message } => {
            serde_json::json!({ "state": "error", "message": message })
        }
    }
}

/// Lo que contestó `voice.end` (`{ transcript: { text, durationSec, capped, device } }`)
/// en lo que la página pinta. Un texto que no cabe en un mensaje, o una nota sin
/// palabras, son un error y no un campo a medio rellenar.
fn done_from(result: &Value) -> VoiceView {
    let empty = Value::Null;
    let transcript = result.get("transcript").unwrap_or(&empty);
    let text = transcript
        .get("text")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if text.trim().is_empty() {
        return VoiceView::Error {
            message: "The note had no words.".to_string(),
        };
    }
    if text.chars().count() > MAX_ASK_CHARS {
        return VoiceView::Error {
            message: "The note is too long.".to_string(),
        };
    }
    VoiceView::Done {
        text: text.to_string(),
        duration_sec: transcript
            .get("durationSec")
            .and_then(Value::as_f64)
            .unwrap_or(0.0),
        capped: transcript
            .get("capped")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    }
}

/// Los motivos del daemon (`docs/protocol.md` §35) en algo que se pueda leer en
/// una línea. Lo que no se conoce se deja como vino.
fn explain(message: &str) -> String {
    match message.trim() {
        "" => "The note could not be transcribed.".to_string(),
        "voice-disabled" => "Voice notes are off in the config (`voice.enabled`).".to_string(),
        "voice-model-missing" => {
            "The voice model is not downloaded: run `stratum voice download`.".to_string()
        }
        "voice-closed" => "The daemon is shutting down.".to_string(),
        "voice-busy" => {
            "The assistant is busy with another note. Try again in a moment.".to_string()
        }
        "voice-failed" => {
            "The note could not be transcribed. The reason is in the daemon log.".to_string()
        }
        other => other.to_string(),
    }
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
        let view = state.ask.view(state.voice.progress());
        let waiting = state.ask.waiting.load(Ordering::SeqCst);
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
            "/status" | "/voice" => match state_json(&path, authentic, waiting, &view) {
                Some(value) => crate::page::json(&value),
                None => not_found(),
            },
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
        "/voice/ack" => {
            // La página ya puso el texto en su campo (o ya enseñó el motivo).
            state.ask.ack();
            responder.respond(json(true, None));
        }
        "/voice/cancel" => {
            // Esc mientras se escucha: se tira el audio y no se transcribe nada.
            state.ask.set_voice(VoiceView::Idle);
            state.ask.reset_hold();
            cancel_note(app.clone());
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

/// Lo que hace la ventana con sus eventos: perder el foco la cierra (como
/// `Esc`) salvo mientras graba o transcribe una nota del atajo; cerrarse la
/// descarta y tira lo que tuviera en curso.
pub fn on_window_event<R: Runtime>(window: &tauri::Window<R>, event: &WindowEvent) {
    let Some(state) = window.try_state::<crate::DotState>() else {
        return;
    };
    match event {
        WindowEvent::Focused(true) => state.ask.focused.store(true, Ordering::SeqCst),
        // Solo tras haberlo tenido: al crearse puede llegar un «sin foco» primero.
        WindowEvent::Focused(false) if state.ask.focused.load(Ordering::SeqCst) => {
            // Mientras se graba o se transcribe desde el atajo, el compacto se
            // queda: la nota es suya y el texto tiene que llegar al campo.
            if !state.ask.voice_busy() {
                close(window.app_handle());
            }
        }
        WindowEvent::Destroyed => {
            state.ask.reset();
            // El compacto era el único sitio donde podía ir esa nota.
            state.voice.abort_from(Origin::Shortcut);
        }
        _ => {}
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
    use serde_json::json;

    fn listening(seconds: u64, level: Option<f32>) -> VoiceView {
        VoiceView::Listening { seconds, level }
    }

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

    // ------------------------------------------------------------- la voz

    #[test]
    fn soltar_sin_nota_no_borra_el_error_del_arranque() {
        let prompt = AskPrompt::default();
        prompt.set_voice(VoiceView::Error {
            message: "The voice model is not downloaded.".into(),
        });
        prompt.clear_listening();
        assert!(matches!(prompt.view(None), VoiceView::Error { .. }));
        prompt.set_voice(VoiceView::Listening {
            seconds: 0,
            level: None,
        });
        prompt.clear_listening();
        assert_eq!(prompt.view(None), VoiceView::Idle);
    }

    #[test]
    fn la_voz_sin_nonce_es_404() {
        // Como `/status`: sin el `nonce` de la página servida no hay nada.
        assert!(state_json("/voice", false, 0, &VoiceView::Idle).is_none());
        assert!(state_json("/status", false, 3, &VoiceView::Idle).is_none());
        assert!(state_json("/otra-cosa", true, 0, &VoiceView::Idle).is_none());
        assert_eq!(
            state_json("/status", true, 3, &VoiceView::Idle),
            Some(json!({ "waiting": 3 }))
        );
        assert_eq!(
            state_json("/voice", true, 0, &VoiceView::Idle),
            Some(json!({ "state": "idle" }))
        );
    }

    #[test]
    fn el_json_de_cada_estado() {
        assert_eq!(voice_json(&VoiceView::Idle), json!({ "state": "idle" }));
        assert_eq!(
            voice_json(&listening(3, Some(-42.5))),
            json!({ "state": "listening", "seconds": 3, "level": -42.5 })
        );
        // Aún sin muestras: el nivel va a `null`, no a cero.
        assert_eq!(
            voice_json(&listening(0, None)),
            json!({ "state": "listening", "seconds": 0, "level": null })
        );
        assert_eq!(
            voice_json(&VoiceView::Transcribing),
            json!({ "state": "transcribing" })
        );
        assert_eq!(
            voice_json(&VoiceView::Done {
                text: "hola".into(),
                duration_sec: 7.4,
                capped: true,
            }),
            json!({ "state": "done", "text": "hola", "durationSec": 7.4, "capped": true })
        );
        assert_eq!(
            voice_json(&VoiceView::Error {
                message: "voice-busy".into()
            }),
            json!({ "state": "error", "message": "voice-busy" })
        );
    }

    #[test]
    fn el_ack_vuelve_a_idle() {
        let prompt = AskPrompt::default();
        assert_eq!(prompt.view(None), VoiceView::Idle);
        prompt.set_voice(VoiceView::Done {
            text: "hola".into(),
            duration_sec: 2.0,
            capped: false,
        });
        assert!(matches!(prompt.view(None), VoiceView::Done { .. }));
        prompt.ack();
        assert_eq!(prompt.view(None), VoiceView::Idle);
        prompt.set_voice(VoiceView::Error {
            message: "voice-busy".into(),
        });
        prompt.ack();
        assert_eq!(prompt.view(None), VoiceView::Idle);
    }

    #[test]
    fn los_segundos_y_el_nivel_los_pone_la_grabacion() {
        let prompt = AskPrompt::default();
        prompt.set_voice(listening(0, None));
        assert_eq!(
            prompt.view(Some(Progress {
                seconds: 3,
                level: Some(-20.0),
            })),
            listening(3, Some(-20.0))
        );
        // Sin nivel nuevo se queda el último: la barra no baja de golpe.
        assert_eq!(
            prompt.view(Some(Progress {
                seconds: 4,
                level: None,
            })),
            listening(4, Some(-20.0))
        );
        // Y si no hay nota, no se inventa un nivel.
        assert_eq!(prompt.view(None), listening(4, Some(-20.0)));
        // Fuera de `listening` no se toca nada.
        prompt.set_voice(VoiceView::Transcribing);
        assert_eq!(
            prompt.view(Some(Progress {
                seconds: 9,
                level: Some(-3.0),
            })),
            VoiceView::Transcribing
        );
    }

    #[test]
    fn si_el_compacto_se_cierra_mientras_transcribe_el_texto_no_sale_luego() {
        let prompt = AskPrompt::default();
        prompt.set_voice(VoiceView::Transcribing);
        prompt.finish_voice(VoiceView::Done {
            text: "hola".into(),
            duration_sec: 2.0,
            capped: false,
        });
        assert!(matches!(prompt.view(None), VoiceView::Done { .. }));

        // Cerrado el compacto (vuelve a `idle`) mientras transcribía, el texto
        // se tira: no aparece en una nota posterior.
        prompt.set_voice(VoiceView::Transcribing);
        prompt.reset();
        prompt.finish_voice(VoiceView::Done {
            text: "hola".into(),
            duration_sec: 2.0,
            capped: false,
        });
        assert_eq!(prompt.view(None), VoiceView::Idle);
    }

    #[test]
    fn escuchar_es_lo_unico_que_impide_cerrar_el_compacto() {
        assert!(listening(1, None).busy());
        assert!(VoiceView::Transcribing.busy());
        assert!(!VoiceView::Idle.busy());
        assert!(!VoiceView::Error {
            message: "x".into()
        }
        .busy());
        assert!(!VoiceView::Done {
            text: "x".into(),
            duration_sec: 1.0,
            capped: false
        }
        .busy());
    }

    #[test]
    fn el_texto_de_la_nota_se_acota_al_de_un_mensaje() {
        let fits = json!({ "transcript": { "text": "hola", "durationSec": 7.4, "capped": true } });
        assert_eq!(
            done_from(&fits),
            VoiceView::Done {
                text: "hola".into(),
                duration_sec: 7.4,
                capped: true,
            }
        );
        // Justo en el tope, cabe; un carácter más, no.
        let at_top = json!({ "transcript": { "text": "ñ".repeat(MAX_ASK_CHARS) } });
        assert!(matches!(done_from(&at_top), VoiceView::Done { .. }));
        let too_long = json!({ "transcript": { "text": "ñ".repeat(MAX_ASK_CHARS + 1) } });
        assert_eq!(
            done_from(&too_long),
            VoiceView::Error {
                message: "The note is too long.".into()
            }
        );
        // Una nota sin palabras no rellena el campo con nada.
        let empty = json!({ "transcript": { "text": "   " } });
        assert!(matches!(done_from(&empty), VoiceView::Error { .. }));
        assert!(matches!(done_from(&Value::Null), VoiceView::Error { .. }));
    }

    #[test]
    fn los_motivos_del_daemon_se_leen() {
        assert!(explain("voice-model-missing").contains("stratum voice download"));
        assert!(explain("voice-busy").contains("busy"));
        // Lo que no se conoce se deja como vino: nunca se inventa un motivo.
        assert_eq!(
            explain("Microphone at 44100 Hz is not supported."),
            "Microphone at 44100 Hz is not supported."
        );
        assert!(!explain("").is_empty());
    }

    #[test]
    fn el_texto_de_la_nota_no_va_al_log() {
        // El texto (y la transcripción) se quedan en la página: lo único que se
        // registra es que hubo un mensaje o que una nota no se pudo transcribir.
        let source = include_str!("ask.rs");
        let runtime = source.split("#[cfg(test)]").next().unwrap_or_default();
        let mut calls = 0;
        for rest in runtime.split("logger").skip(1) {
            let Some(open) = rest.find('(') else { continue };
            let Some(close) = rest[open..].find(");") else {
                continue;
            };
            let call = rest[open..open + close].to_lowercase();
            calls += 1;
            assert!(
                !call.contains("text") && !call.contains("transcript"),
                "el texto no va al log: {call}"
            );
        }
        assert!(calls > 0, "hay llamadas al log que revisar");
    }
}
