//! Todo lo que el webview puede pedir sobre sesiones (M12). Es una **lista
//! blanca tipada**: cada comando hace una cosa, con sus argumentos, y no existe
//! un comando genérico para enviar un método cualquiera del protocolo (el relé
//! `sidecar_send` de D0–D7 ya no existe).
//!
//! `cliente pide → stratumd arbitra → SessionHost ejecuta`: Desktop es un
//! cliente hermano de la CLI y de Dot. Aquí no hay runtime de agente, ni
//! registro de sesiones, ni turnos propios: cada comando es una petición al
//! daemon por el enlace (`dot_link`, perfil [`dot_link::ClientProfile::DESKTOP`]),
//! y lo que cambie llega después por eventos.
//!
//! Lo que no hay, a propósito: nada que apague el daemon, aloje sesiones,
//! pase variables de entorno a una sesión o devuelva el token; y nada que
//! **apruebe**: Desktop todavía no tiene la autoridad de aprobador separada
//! (broker nativo y confirmación, M8/M9). Las aprobaciones, preguntas y planes
//! se ven, y se resuelven desde Stratum Dot o `stratum approvals`.
//!
//! Lo que devuelven las llamadas es el `result` del daemon **sin interpretar**:
//! un DTO del protocolo que el webview valida contra el contrato antes de usarlo.

use dot_link::{CallAction, CommandError, CommandErrorKind, ControlAction};
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_opener::OpenerExt;

use crate::prefs::DesktopPrefs;
use crate::workspace::WorkspaceState;
use crate::DesktopState;

/// Agente con el que se abren las conversaciones de Desktop (`agent/presets.ts`).
const ASSISTANT_AGENT: &str = "assistant";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    desktop_version: &'static str,
    /// Versión del Stratum Protocol que habla este cliente.
    protocol: u64,
}

/// La interfaz está lista. El estado de la conexión, la foto de conjunto y la
/// de la sesión que se mire le llegan después por `desktop://event`.
#[tauri::command]
pub fn desktop_attach(state: State<'_, DesktopState>) -> AppInfo {
    state.link.attach();
    AppInfo {
        desktop_version: env!("CARGO_PKG_VERSION"),
        protocol: dot_link::PROTOCOL_VERSION,
    }
}

/// Volver a empezar: descubrir, arrancar el daemon si hace falta, conectar.
#[tauri::command]
pub fn desktop_retry(state: State<'_, DesktopState>) {
    state.link.retry();
}

/// Qué sesión se mira: la única de la que se pide la conversación.
#[tauri::command]
pub fn desktop_focus_session(state: State<'_, DesktopState>, session_id: Option<String>) {
    state.link.focus(session_id);
}

#[tauri::command]
pub fn desktop_resync_session(state: State<'_, DesktopState>, session_id: String) {
    state.link.resync_session(session_id);
}

#[tauri::command]
pub async fn desktop_pause_run(
    state: State<'_, DesktopState>,
    session_id: String,
    run_id: Option<String>,
) -> Result<String, CommandError> {
    state
        .link
        .control(ControlAction::Pause { session_id, run_id })
        .await
}

#[tauri::command]
pub async fn desktop_resume_run(
    state: State<'_, DesktopState>,
    session_id: String,
    run_id: Option<String>,
) -> Result<String, CommandError> {
    state
        .link
        .control(ControlAction::Resume { session_id, run_id })
        .await
}

#[tauri::command]
pub async fn desktop_cancel_run(
    state: State<'_, DesktopState>,
    session_id: String,
    run_id: Option<String>,
) -> Result<String, CommandError> {
    state
        .link
        .control(ControlAction::Cancel { session_id, run_id })
        .await
}

#[tauri::command]
pub async fn desktop_steer_run(
    state: State<'_, DesktopState>,
    session_id: String,
    text: String,
) -> Result<String, CommandError> {
    state
        .link
        .control(ControlAction::Steer { session_id, text })
        .await
}

/// Conversación nueva con el asistente: Desktop crea su carpeta y pide al
/// daemon una sesión normal con `agent: 'assistant'` en ella. Si el daemon la
/// rechaza (o no salió), la carpeta vacía se quita; si el resultado es
/// desconocido se deja: la sesión puede existir y usarla.
#[tauri::command]
pub async fn desktop_new_chat(
    app: AppHandle,
    state: State<'_, DesktopState>,
    provider: Option<String>,
    model: Option<String>,
) -> Result<Value, CommandError> {
    let local = |message: String| CommandError::new(CommandErrorKind::NotSent, message);
    let info = app.state::<WorkspaceState>().info().map_err(local)?;
    let folders = info.clone();
    let (id, dir) = tauri::async_runtime::spawn_blocking(move || folders.create_folder())
        .await
        .map_err(|e| local(e.to_string()))?
        .map_err(local)?;
    let opened = state
        .link
        .call(CallAction::OpenSession {
            cwd: Some(dir.to_string_lossy().into_owned()),
            agent: Some(ASSISTANT_AGENT.into()),
            provider,
            model,
        })
        .await;
    if let Err(error) = &opened {
        if error.kind != CommandErrorKind::Unknown {
            info.remove_unused_folder(&id);
        }
    }
    opened
}

/// Un mensaje: un run nuevo de esa sesión.
#[tauri::command]
pub async fn desktop_start_run(
    state: State<'_, DesktopState>,
    session_id: String,
    input: String,
) -> Result<Value, CommandError> {
    state
        .link
        .call(CallAction::StartRun { session_id, input })
        .await
}

#[tauri::command]
pub async fn desktop_list_models(state: State<'_, DesktopState>) -> Result<Value, CommandError> {
    state.link.call(CallAction::ListModels).await
}

#[tauri::command]
pub async fn desktop_set_model(
    state: State<'_, DesktopState>,
    session_id: String,
    model: String,
    provider: Option<String>,
) -> Result<Value, CommandError> {
    state
        .link
        .call(CallAction::SetModel {
            session_id,
            model,
            provider,
        })
        .await
}

/// Cerrar una sesión: en el daemon deja de existir, también guardada (M11).
/// Su carpeta de ficheros, si la tiene, se queda donde está.
#[tauri::command]
pub async fn desktop_close_session(
    state: State<'_, DesktopState>,
    session_id: String,
) -> Result<Value, CommandError> {
    state
        .link
        .call(CallAction::CloseSession { session_id })
        .await
}

/// Una página de la conversación guardada (M11), hacia atrás desde `before`.
#[tauri::command]
pub async fn desktop_history(
    state: State<'_, DesktopState>,
    session_id: String,
    before: Option<String>,
    limit: Option<u32>,
) -> Result<Value, CommandError> {
    state
        .link
        .call(CallAction::History {
            session_id,
            before,
            limit,
        })
        .await
}

#[tauri::command]
pub async fn desktop_context(
    state: State<'_, DesktopState>,
    session_id: String,
) -> Result<Value, CommandError> {
    state.link.call(CallAction::Context { session_id }).await
}

#[tauri::command]
pub async fn desktop_memory(
    state: State<'_, DesktopState>,
    session_id: String,
) -> Result<Value, CommandError> {
    state.link.call(CallAction::Memory { session_id }).await
}

/// Las skills que tiene el asistente (`skills.list`), según el daemon. El
/// agente es fijo: el webview no elige de quién se piden.
#[tauri::command]
pub async fn desktop_list_skills(state: State<'_, DesktopState>) -> Result<Value, CommandError> {
    state
        .link
        .call(CallAction::ListSkills {
            agent: Some("assistant".into()),
            cwd: None,
        })
        .await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrefsView {
    #[serde(flatten)]
    prefs: DesktopPrefs,
    /// El atajo configurado no se pudo registrar (otra app lo usa…).
    hotkey_error: Option<String>,
}

/// Las preferencias de la app, de solo lectura (`prefs.rs`).
#[tauri::command]
pub fn desktop_prefs(state: State<'_, DesktopState>) -> PrefsView {
    PrefsView {
        prefs: state.prefs.clone(),
        hotkey_error: state.hotkey_error.clone(),
    }
}

/// Abre el `.stratumrc.json` global con la app del sistema, para editarlo a mano.
#[tauri::command]
pub fn desktop_open_config(app: AppHandle, state: State<'_, DesktopState>) -> Result<(), String> {
    let path = std::path::PathBuf::from(&state.prefs.config_path);
    if !path.is_file() {
        return Err("Todavía no hay fichero de configuración: créalo con `stratum init` o `stratum config set`.".into());
    }
    app.opener()
        .open_path(state.prefs.config_path.clone(), None::<&str>)
        .map_err(|e| format!("no se pudo abrir: {e}"))
}
