//! Todo lo que el webview puede pedir al lado nativo. Es una **lista blanca
//! tipada**: cada comando hace una cosa, con sus argumentos, y no existe un
//! comando genérico para enviar un método cualquiera del protocolo.
//!
//! Lo que no hay, a propósito: nada que apague el daemon, **cierre** o
//! reconfigure una sesión, resuelva aprobaciones, lea ficheros, pase variables
//! de entorno a una sesión o devuelva el token.
//!
//! Lo que devuelven `dot_open_session`, `dot_start_run`, `dot_list_agents` y
//! `dot_list_models` es el `result` del daemon **sin interpretar**: un DTO del
//! protocolo que el webview valida contra el contrato antes de usarlo.

use dot_link::{CallAction, CommandError, ControlAction};
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Runtime, State, WebviewWindow};

use crate::DotState;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    dot_version: &'static str,
    /// Versión del Stratum Protocol que habla este Dot.
    protocol: u64,
    tray_available: bool,
}

/// La interfaz está lista. El estado de la conexión y una foto de cada sesión
/// le llegan a continuación por `dot://event`.
#[tauri::command]
pub fn dot_attach(state: State<'_, DotState>) -> AppInfo {
    state.link.attach();
    AppInfo {
        dot_version: env!("CARGO_PKG_VERSION"),
        protocol: dot_link::PROTOCOL_VERSION,
        tray_available: state.tray.is_some(),
    }
}

/// Volver a empezar: descubrir, arrancar el daemon si hace falta, conectar.
#[tauri::command]
pub fn dot_retry(state: State<'_, DotState>) {
    state.link.retry();
}

#[tauri::command]
pub fn dot_focus_session(state: State<'_, DotState>, session_id: Option<String>) {
    state.link.focus(session_id);
}

#[tauri::command]
pub fn dot_resync_session(state: State<'_, DotState>, session_id: String) {
    state.link.resync_session(session_id);
}

#[tauri::command]
pub async fn dot_pause_run(
    state: State<'_, DotState>,
    session_id: String,
    run_id: Option<String>,
) -> Result<String, CommandError> {
    state
        .link
        .control(ControlAction::Pause { session_id, run_id })
        .await
}

#[tauri::command]
pub async fn dot_resume_run(
    state: State<'_, DotState>,
    session_id: String,
    run_id: Option<String>,
) -> Result<String, CommandError> {
    state
        .link
        .control(ControlAction::Resume { session_id, run_id })
        .await
}

#[tauri::command]
pub async fn dot_cancel_run(
    state: State<'_, DotState>,
    session_id: String,
    run_id: Option<String>,
) -> Result<String, CommandError> {
    state
        .link
        .control(ControlAction::Cancel { session_id, run_id })
        .await
}

#[tauri::command]
pub async fn dot_steer_run(
    state: State<'_, DotState>,
    session_id: String,
    text: String,
) -> Result<String, CommandError> {
    state
        .link
        .control(ControlAction::Steer { session_id, text })
        .await
}

/// Abre una sesión **alojada en el daemon**. Todo es opcional: lo que falte lo
/// decide el daemon (su directorio por defecto, su configuración). El `cwd` es
/// solo un texto: quien comprueba que existe y es un directorio es el daemon.
/// La sesión aparece en la interfaz cuando el daemon la publica, no aquí.
#[tauri::command]
pub async fn dot_open_session(
    state: State<'_, DotState>,
    cwd: Option<String>,
    agent: Option<String>,
    provider: Option<String>,
    model: Option<String>,
) -> Result<Value, CommandError> {
    state
        .link
        .call(CallAction::OpenSession {
            cwd,
            agent,
            provider,
            model,
        })
        .await
}

/// Un mensaje del usuario: un run nuevo de esa sesión. Si ya hay uno en curso
/// el daemon lo rechaza (`BUSY`); para eso está `dot_steer_run`.
#[tauri::command]
pub async fn dot_start_run(
    state: State<'_, DotState>,
    session_id: String,
    input: String,
) -> Result<Value, CommandError> {
    state
        .link
        .call(CallAction::StartRun { session_id, input })
        .await
}

#[tauri::command]
pub async fn dot_list_agents(
    state: State<'_, DotState>,
    cwd: Option<String>,
) -> Result<Value, CommandError> {
    state.link.call(CallAction::ListAgents { cwd }).await
}

#[tauri::command]
pub async fn dot_list_models(state: State<'_, DotState>) -> Result<Value, CommandError> {
    state.link.call(CallAction::ListModels).await
}

/// `Esc`: quita la ventana de en medio. Con bandeja se oculta; sin ella se
/// minimiza, para que siga habiendo por dónde volver.
#[tauri::command]
pub fn dot_hide<R: Runtime>(window: WebviewWindow<R>, state: State<'_, DotState>) {
    if state.tray.is_some() {
        let _ = window.hide();
    } else {
        let _ = window.minimize();
    }
}

/// Termina Dot. El daemon y sus sesiones siguen.
#[tauri::command]
pub fn dot_quit<R: Runtime>(app: AppHandle<R>, state: State<'_, DotState>) {
    state.logger.info("quit requested from the window");
    app.exit(0);
}
