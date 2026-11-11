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
//! reciba o devuelva la clave de aprobador. Resolver aprobaciones, preguntas y
//! planes es como en Stratum Dot (`docs/dot.md` §13–§14): el webview pide
//! **qué** resolver (`desktop_approve`, `desktop_deny`, `desktop_answer_questions`,
//! `desktop_decide_plan`) y el broker nativo (`dot_link::approver`, otra
//! conexión) decide con qué autoridad; desbloquear abre otra ventana
//! (`unlock.rs`) y lo sensible solo sale confirmado en la suya (`confirm.rs`).
//! Esos comandos solo se atienden desde la ventana principal (además del
//! manifiesto de `build.rs`, que ya se lo niega a cualquier otra).
//!
//! Lo que devuelven las llamadas es el `result` del daemon **sin interpretar**:
//! un DTO del protocolo que el webview valida contra el contrato antes de usarlo.
//!
//! **Modo código**: además de las conversaciones con el asistente, el webview
//! puede abrir y conducir sesiones del agente de código (las de la CLI) en una
//! carpeta de proyecto que elige la persona en un diálogo nativo
//! (`desktop_new_code_session`, perfil, solo lectura, jobs, cambios y diff de
//! git). Deshacer turnos (`sessions.revert`, exige `approve`) va por el broker
//! como resolver, con su propio punto de entrada documentado (`revert`).

use dot_link::{
    ApproverAction, ApproverStatus, CallAction, CommandError, CommandErrorKind, ControlAction,
    QuestionAnswer, RevertStep,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager, Runtime, State, WebviewWindow};
use tauri_plugin_opener::OpenerExt;

use crate::prefs::DesktopPrefs;
use crate::settings::{self, ChangeOutcome, NewProvider, SettingsView};
use crate::settings_cli::InstalledCli;
use crate::settings_gate::WindowConfirmer;
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

/// De qué sesión se retransmite la traza al panel de trayectoria (solo
/// lectura, `observe`), o de ninguna. El enlace la abre y la reabre al
/// reconectar; llega como `trace-records` / `trace-unavailable`.
#[tauri::command]
pub fn desktop_trace_session(state: State<'_, DesktopState>, session_id: Option<String>) {
    state.link.trace(session_id);
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
    images: Vec<String>,
) -> Result<String, CommandError> {
    state
        .link
        .control(ControlAction::Steer {
            session_id,
            text,
            images,
        })
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

/// Modo código: el diálogo nativo de elegir la carpeta de un proyecto. La ruta
/// absoluta, o `None` si se cancela. El webview no recibe permisos del diálogo.
#[tauri::command]
pub async fn desktop_pick_project_folder(
    app: AppHandle,
    window: WebviewWindow,
) -> Result<Option<String>, CommandError> {
    main_window(&window)?;
    crate::files::pick_project_folder(app, window)
        .await
        .map_err(|message| CommandError::new(CommandErrorKind::NotSent, message))
}

/// Modo código: una sesión del agente de código en la carpeta de un proyecto.
/// `agent` es un **perfil** de código (un agente embebido no vale). No crea la
/// carpeta ni la registra: es del usuario, y el daemon la vuelve a comprobar.
#[tauri::command]
pub async fn desktop_new_code_session(
    state: State<'_, DesktopState>,
    cwd: String,
    agent: Option<String>,
    provider: Option<String>,
    model: Option<String>,
) -> Result<Value, CommandError> {
    crate::code::check_code_agent(&agent)?;
    crate::code::check_project_dir(&cwd)?;
    state
        .link
        .call(CallAction::OpenSession {
            cwd: Some(cwd),
            agent,
            provider,
            model,
        })
        .await
}

/// Modo código: los perfiles de agente que se pueden elegir (con los del
/// proyecto de `cwd`, si se da).
#[tauri::command]
pub async fn desktop_list_agents(
    state: State<'_, DesktopState>,
    cwd: Option<String>,
) -> Result<Value, CommandError> {
    state.link.call(CallAction::ListAgents { cwd }).await
}

/// Modo código: otro perfil de agente de código para una sesión parada, o
/// ninguno (`None`). Un agente embebido no se elige así.
#[tauri::command]
pub async fn desktop_set_agent(
    state: State<'_, DesktopState>,
    session_id: String,
    agent: Option<String>,
) -> Result<Value, CommandError> {
    crate::code::check_code_agent(&agent)?;
    state
        .link
        .call(CallAction::SetAgent { session_id, agent })
        .await
}

/// Modo código: solo lectura de una sesión parada.
#[tauri::command]
pub async fn desktop_set_read_only(
    state: State<'_, DesktopState>,
    session_id: String,
    read_only: bool,
) -> Result<Value, CommandError> {
    state
        .link
        .call(CallAction::SetReadOnly {
            session_id,
            read_only,
        })
        .await
}

/// Modo código: el perfil de sesión (`code`, `infra`, `full`, `auto`…) de una
/// sesión parada. Qué perfiles existen lo decide el daemon.
#[tauri::command]
pub async fn desktop_set_session_profile(
    state: State<'_, DesktopState>,
    session_id: String,
    profile: String,
) -> Result<Value, CommandError> {
    state
        .link
        .call(CallAction::SetSessionProfile {
            session_id,
            profile,
        })
        .await
}

/// Modo código: cómo está montada una sesión (perfil, tools, MCP, plugins y
/// entornos). Solo lectura; no la monta.
#[tauri::command]
pub async fn desktop_inspect_session(
    state: State<'_, DesktopState>,
    session_id: String,
) -> Result<Value, CommandError> {
    state
        .link
        .call(CallAction::InspectSession { session_id })
        .await
}

/// Modo código: parar un job en segundo plano de una sesión (solo resta).
#[tauri::command]
pub async fn desktop_cancel_job(
    state: State<'_, DesktopState>,
    session_id: String,
    job_id: String,
) -> Result<Value, CommandError> {
    state
        .link
        .call(CallAction::CancelJob { session_id, job_id })
        .await
}

/// Modo código: los cambios del working tree del proyecto de la sesión.
#[tauri::command]
pub async fn desktop_git_changes(
    state: State<'_, DesktopState>,
    session_id: String,
) -> Result<Value, CommandError> {
    state.link.call(CallAction::GitChanges { session_id }).await
}

/// Modo código: el diff de un fichero de `desktop_git_changes` (la ruta la
/// confina el daemon; sale con los secretos redactados).
#[tauri::command]
pub async fn desktop_git_diff(
    state: State<'_, DesktopState>,
    session_id: String,
    path: String,
) -> Result<Value, CommandError> {
    state
        .link
        .call(CallAction::GitDiff { session_id, path })
        .await
}

/// Un mensaje: un run nuevo de esa sesión.
#[tauri::command]
pub async fn desktop_start_run(
    state: State<'_, DesktopState>,
    session_id: String,
    input: String,
    images: Vec<String>,
    plan: Option<bool>,
) -> Result<Value, CommandError> {
    state
        .link
        .call(CallAction::StartRun {
            session_id,
            input,
            images,
            plan: plan.unwrap_or(false),
        })
        .await
}

/// Modo código: el navegador del agente de la sesión, su estado y la pestaña en
/// JPEG (solo lectura; el daemon nunca lo arranca por esto).
#[tauri::command]
pub async fn desktop_browser_screen(
    state: State<'_, DesktopState>,
    session_id: String,
) -> Result<Value, CommandError> {
    state
        .link
        .call(CallAction::BrowserScreen { session_id })
        .await
}

/// Modo código: la persona mueve ese navegador (`goto`, `back`, `forward`,
/// `reload`). Solo lo local o ya aprobado: aprobar un sitio es del agente, por
/// su confirmación; `dot-link` valida la acción y el tope de la URL.
#[tauri::command]
pub async fn desktop_browser_navigate(
    state: State<'_, DesktopState>,
    session_id: String,
    action: String,
    url: Option<String>,
) -> Result<Value, CommandError> {
    state
        .link
        .call(CallAction::BrowserNavigate {
            session_id,
            action,
            url,
        })
        .await
}

/// Una imagen pegada en el campo: valida la firma y el tamaño, la guarda en
/// `<home>/.stratum/images/` (el home de `dot_link`, no el del SO: ver
/// `images.rs`) y devuelve su ruta absoluta para `images` de `runs.start`.
#[tauri::command]
pub async fn desktop_save_pasted_image(bytes: Vec<u8>) -> Result<String, CommandError> {
    let local = |message: String| CommandError::new(CommandErrorKind::NotSent, message);
    let home = dot_link::discovery::home_dir()
        .ok_or_else(|| local("No se pudo resolver el directorio del usuario.".into()))?;
    let saved = tauri::async_runtime::spawn_blocking(move || {
        crate::images::save_in(
            &crate::images::images_dir(&home),
            &bytes,
            std::time::SystemTime::now(),
        )
    })
    .await
    .map_err(|e| local(e.to_string()))?
    .map_err(local)?;
    Ok(saved.to_string_lossy().into_owned())
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

/// La memoria global del asistente (`memory.decisions`): las últimas decisiones,
/// o la búsqueda si hay consulta. De quién es la memoria lo fija el perfil del
/// enlace (`ClientProfile::DESKTOP` → `assistant`), no el webview.
#[tauri::command]
pub async fn desktop_memory_decisions(
    state: State<'_, DesktopState>,
    query: Option<String>,
) -> Result<Value, CommandError> {
    state.link.call(CallAction::MemoryDecisions { query }).await
}

/// Olvidar una decisión del asistente. Solo resta: conexión principal
/// (capacidad `control`); sin respuesta queda `unknown` y no se repite.
#[tauri::command]
pub async fn desktop_memory_forget(
    state: State<'_, DesktopState>,
    decision_id: String,
) -> Result<Value, CommandError> {
    state
        .link
        .call(CallAction::MemoryForget { decision_id })
        .await
}

/// M19 fase 5 — las propuestas de dreaming pendientes del asistente. Solo lectura.
#[tauri::command]
pub async fn desktop_memory_proposals(
    state: State<'_, DesktopState>,
) -> Result<Value, CommandError> {
    state.link.call(CallAction::MemoryProposals).await
}

/// M19 fase 5 — pedir una pasada de dreaming: **solo propone**. Gasta modelo;
/// sin respuesta queda `unknown` y no se repite.
#[tauri::command]
pub async fn desktop_memory_dream(
    state: State<'_, DesktopState>,
    force: Option<bool>,
) -> Result<Value, CommandError> {
    state
        .link
        .call(CallAction::MemoryDream {
            force: force.unwrap_or(false),
        })
        .await
}

/// M19 fase 5 — aplicar una propuesta (lo que cambia la memoria): conexión
/// principal (`control`), como olvidar.
#[tauri::command]
pub async fn desktop_memory_apply_proposal(
    state: State<'_, DesktopState>,
    proposal_id: String,
) -> Result<Value, CommandError> {
    state
        .link
        .call(CallAction::MemoryApplyProposal { proposal_id })
        .await
}

/// M19 fase 5 — rechazar una propuesta: la memoria no se toca.
#[tauri::command]
pub async fn desktop_memory_reject_proposal(
    state: State<'_, DesktopState>,
    proposal_id: String,
) -> Result<Value, CommandError> {
    state
        .link
        .call(CallAction::MemoryRejectProposal { proposal_id })
        .await
}

/// M19 — mover un recuerdo del asistente a otra sección. Conexión principal
/// (capacidad `control`): no cambia lo que el agente puede hacer. La sección la
/// valida `dot-link`; sin respuesta queda `unknown` y no se repite.
#[tauri::command]
pub async fn desktop_memory_reclassify(
    state: State<'_, DesktopState>,
    decision_id: String,
    section: String,
) -> Result<Value, CommandError> {
    state
        .link
        .call(CallAction::MemoryReclassify {
            decision_id,
            section,
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

/// Un cambio de ajustes a la vez: leer, confirmar, releer y escribir no se mezclan.
fn settings_guard(state: &DesktopState) -> Result<std::sync::MutexGuard<'_, ()>, CommandError> {
    match state.settings_busy.try_lock() {
        Ok(guard) => Ok(guard),
        Err(std::sync::TryLockError::Poisoned(p)) => Ok(p.into_inner()),
        Err(std::sync::TryLockError::WouldBlock) => Err(CommandError::new(
            CommandErrorKind::NotSent,
            "Ya hay un cambio de ajustes en curso.",
        )),
    }
}

fn settings_task_failed() -> CommandError {
    CommandError::new(
        CommandErrorKind::NotSent,
        "No se pudo atender la petición de ajustes.",
    )
}

/// Los ajustes editables, con los secretos enmascarados (`settings.rs`). Lo lee
/// la CLI instalada; sin una que sirva, la vista es de solo lectura.
#[tauri::command]
pub async fn desktop_settings_get<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
) -> Result<SettingsView, CommandError> {
    main_window(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<DesktopState>();
        settings::load_view(
            &InstalledCli::from_env(),
            std::path::Path::new(&state.prefs.config_path),
        )
    })
    .await
    .map_err(|_| settings_task_failed())
}

/// Cambia una clave editable del `.stratumrc.json` global. El nivel lo decide
/// el lado nativo: el B abre la ventana de confirmación y solo escribe si la
/// persona confirma allí y el valor no cambió mientras tanto.
#[tauri::command]
pub async fn desktop_settings_set<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
    path: String,
    value: Value,
) -> Result<ChangeOutcome, CommandError> {
    main_window(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<DesktopState>();
        let _busy = settings_guard(&state)?;
        let presenter =
            crate::confirm::TauriPresenter::new(app.clone(), state.confirm_windows.clone());
        let confirmer = WindowConfirmer {
            gate: &state.settings_gate,
            presenter: &presenter,
        };
        settings::apply_set(
            &InstalledCli::from_env(),
            &confirmer,
            std::path::Path::new(&state.prefs.config_path),
            &path,
            &value,
        )
    })
    .await
    .map_err(|_| settings_task_failed())?
}

/// Añade un provider nuevo (siempre con confirmación nativa: una dirección y una clave).
#[tauri::command]
pub async fn desktop_settings_add_provider<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
    provider: NewProvider,
) -> Result<ChangeOutcome, CommandError> {
    main_window(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<DesktopState>();
        let _busy = settings_guard(&state)?;
        let presenter =
            crate::confirm::TauriPresenter::new(app.clone(), state.confirm_windows.clone());
        let confirmer = WindowConfirmer {
            gate: &state.settings_gate,
            presenter: &presenter,
        };
        settings::apply_add_provider(
            &InstalledCli::from_env(),
            &confirmer,
            std::path::Path::new(&state.prefs.config_path),
            &provider,
        )
    })
    .await
    .map_err(|_| settings_task_failed())?
}

fn main_window<R: Runtime>(window: &WebviewWindow<R>) -> Result<(), CommandError> {
    if window.label() == "main" {
        Ok(())
    } else {
        Err(CommandError::new(
            CommandErrorKind::NotSent,
            "No disponible desde esta ventana.",
        ))
    }
}

/// Estado de la autoridad de aprobar. Sin datos: ni la clave ni nada derivado.
#[tauri::command]
pub fn desktop_approver_status(state: State<'_, DesktopState>) -> ApproverStatus {
    state.broker.status()
}

/// Abre la ventana de desbloqueo (o la trae al frente). La clave se teclea
/// **allí**, no aquí: este comando no la recibe ni la devuelve. Es `async`
/// porque crear una ventana desde un comando síncrono bloquea en Windows.
#[tauri::command]
pub async fn desktop_approver_unlock<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
    state: State<'_, DesktopState>,
) -> Result<(), CommandError> {
    main_window(&window)?;
    if matches!(state.broker.status(), ApproverStatus::Ready { .. }) {
        return Ok(());
    }
    crate::unlock::open(&app, &state.prompt).map_err(|_| {
        CommandError::new(
            CommandErrorKind::NotSent,
            "No se pudo abrir la ventana de desbloqueo.",
        )
    })
}

/// Suelta la autoridad. Lo pendiente sigue pendiente.
#[tauri::command]
pub fn desktop_approver_lock<R: Runtime>(
    window: WebviewWindow<R>,
    state: State<'_, DesktopState>,
) -> Result<(), CommandError> {
    main_window(&window)?;
    state.broker.lock();
    Ok(())
}

/// Resuelve: lo sensible, solo si la persona lo confirma en la ventana nativa;
/// lo negativo, directo. Nunca se confirma solo ni se reenvía.
async fn resolve<R: Runtime>(
    app: AppHandle<R>,
    state: &DesktopState,
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

/// El **otro** punto de entrada al broker, y el único además de [`resolve`]:
/// deshacer turnos (`sessions.revert`, que exige `approve`). Calcular el plan
/// (`dry_run`) no toca nada y va directo, pero con el broker desbloqueado.
/// Deshacer solo sale si la persona lo confirma en la ventana nativa, que enseña
/// el plan que leyó la puerta del daemon; con conflictos o sin nada que deshacer
/// no se abre nada y vuelve la respuesta del daemon. Nunca con `force`, nunca se
/// reenvía, y el resultado vuelve sin interpretar.
async fn revert<R: Runtime>(
    app: AppHandle<R>,
    state: &DesktopState,
    session_id: String,
    turns: u8,
    dry_run: bool,
) -> Result<Value, CommandError> {
    if dry_run {
        return state
            .broker
            .query(ApproverAction::RevertPlan { session_id, turns })
            .await;
    }
    let presenter = crate::confirm::TauriPresenter::new(app, state.confirm_windows.clone());
    match state
        .confirm
        .request_revert(
            &state.link,
            &state.broker,
            &presenter,
            ApproverAction::Revert { session_id, turns },
        )
        .await?
    {
        RevertStep::Answer(result) => Ok(result),
        RevertStep::Confirmed(confirmed) => state.broker.resolve_confirmed_value(confirmed).await,
    }
}

/// Modo código: qué haría deshacer los últimos `turns` turnos (no toca nada).
/// Exige el broker desbloqueado: el daemon solo lo calcula con `approve`.
#[tauri::command]
pub async fn desktop_revert_plan<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
    state: State<'_, DesktopState>,
    session_id: String,
    turns: u8,
) -> Result<Value, CommandError> {
    main_window(&window)?;
    revert(app, &state, session_id, turns, true).await
}

/// Modo código: deshacer los ficheros de los últimos `turns` turnos, con
/// confirmación nativa. Devuelve el `result` del daemon sin interpretar.
#[tauri::command]
pub async fn desktop_revert<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
    state: State<'_, DesktopState>,
    session_id: String,
    turns: u8,
) -> Result<Value, CommandError> {
    main_window(&window)?;
    revert(app, &state, session_id, turns, false).await
}

/// Pide aprobar una solicitud: abre la confirmación nativa, y solo si la
/// persona confirma allí se envía. `for_session` = `allow-all`. La frase de una
/// confirmación con nombre **no** viaja por aquí: se teclea en la ventana.
/// Desktop no ofrece concesiones con caducidad (M17): revocarlas es de Dot.
#[tauri::command]
pub async fn desktop_approve<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
    state: State<'_, DesktopState>,
    session_id: String,
    approval_id: String,
    for_session: bool,
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
            grant_minutes: None,
        },
    )
    .await
}

/// Deniega, directo (sin confirmación): es lo que pasa cuando nadie contesta.
#[tauri::command]
pub async fn desktop_deny<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
    state: State<'_, DesktopState>,
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
pub async fn desktop_answer_questions<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
    state: State<'_, DesktopState>,
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
pub async fn desktop_decide_plan<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
    state: State<'_, DesktopState>,
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
