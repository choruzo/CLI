//! Todo lo que el webview puede pedir al lado nativo. Es una **lista blanca
//! tipada**: cada comando hace una cosa, con sus argumentos, y no existe un
//! comando genérico para enviar un método cualquiera del protocolo.
//!
//! Lo que no hay, a propósito: nada que apague el daemon, **cierre** o
//! reconfigure una sesión, lea ficheros, pase variables de entorno a una
//! sesión o devuelva el token. Y nada que reciba o devuelva la clave de
//! aprobador: el webview pide **resolver** (`dot_approve`, `dot_deny`,
//! `dot_answer_questions`, `dot_decide_plan`) y el broker nativo decide con
//! qué autoridad; desbloquear abre otra ventana (`unlock.rs`), y el webview
//! solo ve su estado.
//!
//! Los comandos de aprobador solo se atienden desde la ventana principal
//! (además del manifiesto de `build.rs`, que ya se lo niega a cualquier otra).
//!
//! Lo que devuelven `dot_open_session`, `dot_start_run`, `dot_list_agents` y
//! `dot_list_models` es el `result` del daemon **sin interpretar**: un DTO del
//! protocolo que el webview valida contra el contrato antes de usarlo.

use dot_link::{
    ApproverAction, ApproverStatus, CallAction, CommandError, CommandErrorKind, ControlAction,
    QuestionAnswer,
};
use serde::Deserialize;
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

fn main_window<R: Runtime>(window: &WebviewWindow<R>) -> Result<(), CommandError> {
    if window.label() == "main" {
        Ok(())
    } else {
        Err(CommandError::new(
            CommandErrorKind::NotSent,
            "Not available from this window.",
        ))
    }
}

/// Estado de la autoridad de aprobar. Sin datos: ni la clave ni nada derivado.
#[tauri::command]
pub fn dot_approver_status(state: State<'_, DotState>) -> ApproverStatus {
    state.broker.status()
}

/// Abre la ventana de desbloqueo (o la trae al frente). La clave se teclea
/// **allí**, no aquí: este comando no la recibe ni la devuelve. Es `async`
/// porque crear una ventana desde un comando síncrono bloquea en Windows.
#[tauri::command]
pub async fn dot_approver_unlock<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
    state: State<'_, DotState>,
) -> Result<(), CommandError> {
    main_window(&window)?;
    if matches!(state.broker.status(), ApproverStatus::Ready { .. }) {
        return Ok(());
    }
    crate::unlock::open(&app, &state.prompt).map_err(|_| {
        CommandError::new(
            CommandErrorKind::NotSent,
            "Could not open the unlock window.",
        )
    })
}

/// Suelta la autoridad. Lo pendiente sigue pendiente.
#[tauri::command]
pub fn dot_approver_lock<R: Runtime>(
    window: WebviewWindow<R>,
    state: State<'_, DotState>,
) -> Result<(), CommandError> {
    main_window(&window)?;
    state.broker.lock();
    Ok(())
}

/// Aprueba una solicitud. `phrase` es lo que tecleó la persona si la solicitud
/// pide frase (no es la clave de aprobador); `for_session` = `allow-all`.
#[tauri::command]
pub async fn dot_approve<R: Runtime>(
    window: WebviewWindow<R>,
    state: State<'_, DotState>,
    session_id: String,
    approval_id: String,
    phrase: Option<String>,
    for_session: bool,
) -> Result<(), CommandError> {
    main_window(&window)?;
    state
        .broker
        .resolve(ApproverAction::Approve {
            session_id,
            approval_id,
            phrase,
            for_session,
        })
        .await
}

#[tauri::command]
pub async fn dot_deny<R: Runtime>(
    window: WebviewWindow<R>,
    state: State<'_, DotState>,
    session_id: String,
    approval_id: String,
) -> Result<(), CommandError> {
    main_window(&window)?;
    state
        .broker
        .resolve(ApproverAction::Deny {
            session_id,
            approval_id,
        })
        .await
}

/// Contesta una tanda de preguntas. `None` la omite.
#[tauri::command]
pub async fn dot_answer_questions<R: Runtime>(
    window: WebviewWindow<R>,
    state: State<'_, DotState>,
    session_id: String,
    request_id: String,
    answers: Option<Vec<QuestionAnswer>>,
) -> Result<(), CommandError> {
    main_window(&window)?;
    state
        .broker
        .resolve(ApproverAction::AnswerQuestions {
            session_id,
            request_id,
            answers,
        })
        .await
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PlanDecision {
    Approve,
    Reject,
}

/// Aprueba el plan propuesto **tal cual**, o lo rechaza. Sin edición.
#[tauri::command]
pub async fn dot_decide_plan<R: Runtime>(
    window: WebviewWindow<R>,
    state: State<'_, DotState>,
    session_id: String,
    request_id: String,
    decision: PlanDecision,
) -> Result<(), CommandError> {
    main_window(&window)?;
    state
        .broker
        .resolve(ApproverAction::DecidePlan {
            session_id,
            request_id,
            approve: matches!(decision, PlanDecision::Approve),
        })
        .await
}

/// Lo pendiente que enseña la interfaz, para la bandeja. Es solo un contador
/// que pinta: no da ni quita nada. Si crece con la ventana sin foco, se pide
/// atención al sistema (sin robar el foco).
#[tauri::command]
pub fn dot_set_attention<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
    state: State<'_, DotState>,
    approvals: u32,
    questions: u32,
    plans: u32,
) {
    if main_window(&window).is_err() {
        return;
    }
    crate::tray::set_pending(&app, &state, approvals, questions, plans);
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
