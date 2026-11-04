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
//! **Pedir no es resolver** (M9): `dot_approve`, `dot_answer_questions` con
//! respuestas y `dot_decide_plan` con `approve` abren la confirmación nativa
//! (`confirm.rs`) y solo envían si la persona confirma allí; la frase de una
//! confirmación con nombre se teclea también allí. Denegar, omitir y rechazar
//! van directos: es lo mismo que hace el runtime cuando nadie contesta.
//!
//! Lo que devuelven `dot_open_session`, `dot_start_run`, `dot_list_agents`,
//! `dot_list_models`, `dot_box_*` y `dot_routines_*` es el `result` del daemon **sin interpretar**: un DTO del
//! protocolo que el webview valida contra el contrato antes de usarlo.

use dot_link::{
    ApproverAction, ApproverStatus, CallAction, CommandError, CommandErrorKind, ControlAction,
    QuestionAnswer, RoutineLimits, RoutinePatch,
};
use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Runtime, State, WebviewWindow};

use crate::{notify, DotState};

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
        .control(ControlAction::Steer {
            session_id,
            text,
            images: Vec::new(),
        })
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
        .call(CallAction::StartRun {
            session_id,
            input,
            images: Vec::new(),
        })
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

/// M14 — estado de la caja del asistente. El `result` va sin interpretar.
#[tauri::command]
pub async fn dot_box_status(state: State<'_, DotState>) -> Result<Value, CommandError> {
    state.link.call(CallAction::BoxStatus).await
}

/// M14 — arrancar la caja. La primera vez el daemon construye su imagen: puede
/// tardar minutos. Las órdenes que recibe el runtime las decide el daemon.
#[tauri::command]
pub async fn dot_box_start(state: State<'_, DotState>) -> Result<Value, CommandError> {
    state.link.call(CallAction::BoxStart).await
}

/// M14 — pararla. Su home se conserva. Borrarla (`box.reset`) no es de Dot.
#[tauri::command]
pub async fn dot_box_stop(state: State<'_, DotState>) -> Result<Value, CommandError> {
    state.link.call(CallAction::BoxStop).await
}

/// M15 — la pantalla de la caja ahora (JPEG en base64), para verla en solo
/// lectura. La captura la toma el daemon con una orden fija; sin parámetros.
#[tauri::command]
pub async fn dot_box_screen(state: State<'_, DotState>) -> Result<Value, CommandError> {
    state.link.call(CallAction::BoxScreen).await
}

/// M16 — las rutinas del asistente. El `result` va sin interpretar.
#[tauri::command]
pub async fn dot_routines_list(state: State<'_, DotState>) -> Result<Value, CommandError> {
    state.link.call(CallAction::RoutinesList).await
}

/// M16 — crear una rutina. Los campos van uno a uno: el lado nativo los valida
/// (topes del contrato) y arma la petición; el webview no pasa un objeto libre.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn dot_routines_add(
    state: State<'_, DotState>,
    name: String,
    schedule: String,
    prompt: String,
    model: Option<String>,
    enabled: Option<bool>,
    max_iterations: Option<u32>,
    timeout_minutes: Option<u32>,
) -> Result<Value, CommandError> {
    let limits = RoutineLimits {
        max_iterations,
        timeout_minutes,
    };
    state
        .link
        .call(CallAction::RoutinesAdd {
            name,
            schedule,
            prompt,
            model,
            enabled,
            limits: (limits != RoutineLimits::default()).then_some(limits),
        })
        .await
}

/// M16 — cambiar una rutina: solo lo que viene en el parche (tipado y cerrado).
#[tauri::command]
pub async fn dot_routines_update(
    state: State<'_, DotState>,
    routine_id: String,
    patch: RoutinePatch,
) -> Result<Value, CommandError> {
    state
        .link
        .call(CallAction::RoutinesUpdate { routine_id, patch })
        .await
}

/// M16 — borrar una rutina **y su sesión**.
#[tauri::command]
pub async fn dot_routines_remove(
    state: State<'_, DotState>,
    routine_id: String,
) -> Result<Value, CommandError> {
    state
        .link
        .call(CallAction::RoutinesRemove { routine_id })
        .await
}

/// M16 — dispararla ya (también deshabilitada).
#[tauri::command]
pub async fn dot_routines_run(
    state: State<'_, DotState>,
    routine_id: String,
) -> Result<Value, CommandError> {
    state
        .link
        .call(CallAction::RoutinesRun { routine_id })
        .await
}

/// M17 — revocar una concesión vigente. Solo resta autoridad: va por la
/// conexión principal (capacidad `control`), sin broker ni confirmación nativa.
#[tauri::command]
pub async fn dot_grants_revoke(
    state: State<'_, DotState>,
    session_id: String,
    grant_id: String,
) -> Result<Value, CommandError> {
    state
        .link
        .call(CallAction::GrantsRevoke {
            session_id,
            grant_id,
        })
        .await
}

/// M17 — las decisiones que recuerda el asistente: las últimas, o la búsqueda si
/// hay consulta. El agente lo fija el lado nativo, no el webview.
#[tauri::command]
pub async fn dot_memory_decisions(
    state: State<'_, DotState>,
    query: Option<String>,
) -> Result<Value, CommandError> {
    state.link.call(CallAction::MemoryDecisions { query }).await
}

/// M17 — olvidar una decisión del asistente. Solo resta: conexión principal
/// (capacidad `control`), sin broker; sin respuesta queda `unknown` y no se repite.
#[tauri::command]
pub async fn dot_memory_forget(
    state: State<'_, DotState>,
    decision_id: String,
) -> Result<Value, CommandError> {
    state
        .link
        .call(CallAction::MemoryForget { decision_id })
        .await
}

/// Cierre de M14 — conversación nueva del asistente: el daemon compacta la
/// actual, la archiva y abre otra que hereda su memoria. Agente y `fresh` los
/// fija el nativo; sin respuesta queda `unknown` y no se repite.
#[tauri::command]
pub async fn dot_new_companion_conversation(
    state: State<'_, DotState>,
) -> Result<Value, CommandError> {
    state.link.call(CallAction::NewCompanionConversation).await
}

/// M18 — el canal de Telegram: estado, emparejados y el candidato, si lo hay.
/// Nunca el token ni el código. El `result` va sin interpretar.
#[tauri::command]
pub async fn dot_channels_status(state: State<'_, DotState>) -> Result<Value, CommandError> {
    state.link.call(CallAction::ChannelsStatus).await
}

/// M18 — un código de emparejamiento de un solo uso y su enlace (para enseñarlo).
/// No da autoridad: quien lo mande al bot queda como candidato, sin emparejar.
#[tauri::command]
pub async fn dot_channels_pair_begin(state: State<'_, DotState>) -> Result<Value, CommandError> {
    state.link.call(CallAction::ChannelsPairBegin).await
}

/// M18 — emparejar el candidato con ese id: da autoridad (hablar con el asistente
/// y aprobar desde Telegram), así que pasa por la confirmación nativa, que lee
/// el candidato **del daemon**, y sale por el broker de aprobador.
#[tauri::command]
pub async fn dot_channels_pair_confirm<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
    state: State<'_, DotState>,
    user_id: i64,
) -> Result<(), CommandError> {
    main_window(&window)?;
    resolve(app, &state, ApproverAction::PairTelegram { user_id }).await
}

/// M18 — desemparejar un chat. Solo resta: conexión principal, sin broker.
#[tauri::command]
pub async fn dot_channels_unpair(
    state: State<'_, DotState>,
    user_id: i64,
) -> Result<Value, CommandError> {
    state
        .link
        .call(CallAction::ChannelsUnpair { user_id })
        .await
}

/// M17 — la memoria de sesión (M11) de una conversación, en solo lectura.
#[tauri::command]
pub async fn dot_session_memory(
    state: State<'_, DotState>,
    session_id: String,
) -> Result<Value, CommandError> {
    state.link.call(CallAction::Memory { session_id }).await
}

/// M16 — avisa al sistema de que una rutina terminó. El texto es plano y
/// acotado aquí, no en el webview; la notificación no lleva acciones. Pulsarla
/// (Windows) o dar el foco a la ventana poco después (resto) abre esa sesión
/// (`notify.rs`).
#[tauri::command]
pub fn dot_notify_routine<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
    state: State<'_, DotState>,
    title: String,
    body: String,
    session_id: String,
) -> Result<(), CommandError> {
    main_window(&window)?;
    if session_id.is_empty() || session_id.chars().count() > dot_link::MAX_ID_CHARS {
        return Err(CommandError::new(
            CommandErrorKind::Invalid,
            "Invalid session id.",
        ));
    }
    let title = notify::plain(&title, notify::MAX_TITLE_CHARS);
    let body = notify::plain(&body, notify::MAX_BODY_CHARS);
    if title.is_empty() {
        return Err(CommandError::new(
            CommandErrorKind::Invalid,
            "The notification has no title.",
        ));
    }
    // Sin el texto: ni el título ni el cuerpo van al log.
    let on_click = {
        let app = app.clone();
        let session_id = session_id.clone();
        move || {
            crate::show_main(&app);
            let _ = app.emit_to(
                "main",
                crate::DOT_EVENT,
                serde_json::json!({ "type": "open-session", "sessionId": session_id }),
            );
        }
    };
    match notify::show(&app, &title, &body, on_click) {
        Ok(()) => {
            state.logger.info("notify: routine");
            // Windows avisa del clic: no hace falta adivinarlo por el foco.
            if !cfg!(windows) {
                state.notice.remember(session_id, std::time::Instant::now());
            }
            Ok(())
        }
        Err(_) => {
            state.logger.warn("notify: the system did not show it");
            Err(CommandError::new(
                CommandErrorKind::NotSent,
                "The system did not show the notification.",
            ))
        }
    }
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

/// Resuelve: lo sensible, solo si la persona lo confirma en la ventana nativa;
/// lo negativo, directo. Nunca se confirma solo ni se reenvía.
async fn resolve<R: Runtime>(
    app: AppHandle<R>,
    state: &DotState,
    action: ApproverAction,
) -> Result<(), CommandError> {
    if !action.needs_confirmation() {
        return state.broker.resolve(action).await;
    }
    let presenter = crate::confirm::TauriPresenter::new(app, state.confirm_windows.clone());
    let confirmed = state
        .confirm
        .request(&state.link, &state.broker, &presenter, action)
        .await?;
    state.broker.resolve_confirmed(confirmed).await
}

/// Pide aprobar una solicitud: abre la confirmación nativa, y solo si la
/// persona confirma allí se envía. `for_session` = `allow-all`; `grant_minutes`
/// (M17) = una concesión de 10, 30 o 60 minutos, que la ventana enseña. La frase
/// de una confirmación con nombre **no** viaja por aquí: se teclea en la ventana.
#[tauri::command]
pub async fn dot_approve<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
    state: State<'_, DotState>,
    session_id: String,
    approval_id: String,
    for_session: bool,
    grant_minutes: Option<u8>,
) -> Result<(), CommandError> {
    main_window(&window)?;
    resolve(
        app,
        &state,
        ApproverAction::Approve {
            session_id,
            approval_id,
            phrase: None,
            for_session,
            grant_minutes,
        },
    )
    .await
}

/// Deniega, directo (sin confirmación): es lo que pasa cuando nadie contesta.
#[tauri::command]
pub async fn dot_deny<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
    state: State<'_, DotState>,
    session_id: String,
    approval_id: String,
) -> Result<(), CommandError> {
    main_window(&window)?;
    resolve(
        app,
        &state,
        ApproverAction::Deny {
            session_id,
            approval_id,
        },
    )
    .await
}

/// Contesta una tanda de preguntas (con confirmación nativa). `None` la omite (directo).
#[tauri::command]
pub async fn dot_answer_questions<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
    state: State<'_, DotState>,
    session_id: String,
    request_id: String,
    answers: Option<Vec<QuestionAnswer>>,
) -> Result<(), CommandError> {
    main_window(&window)?;
    resolve(
        app,
        &state,
        ApproverAction::AnswerQuestions {
            session_id,
            request_id,
            answers,
        },
    )
    .await
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PlanDecision {
    Approve,
    Reject,
}

/// Aprueba el plan propuesto **tal cual** (con confirmación nativa), o lo
/// rechaza (directo). Sin edición.
#[tauri::command]
pub async fn dot_decide_plan<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
    state: State<'_, DotState>,
    session_id: String,
    request_id: String,
    decision: PlanDecision,
) -> Result<(), CommandError> {
    main_window(&window)?;
    resolve(
        app,
        &state,
        ApproverAction::DecidePlan {
            session_id,
            request_id,
            approve: matches!(decision, PlanDecision::Approve),
        },
    )
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
    state
        .ask
        .set_waiting(approvals.saturating_add(questions).saturating_add(plans));
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
