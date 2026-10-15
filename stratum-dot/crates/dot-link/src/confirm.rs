//! La **confirmación nativa** (M9): ninguna resolución sensible sale de Dot sin
//! que la persona la confirme en una superficie que el webview no controla.
//!
//! ```text
//! webview ── dot_approve(id) ──► ConfirmGate::request
//!                                  │ broker listo (su época) ─ si no, nada
//!                                  │ lee del DAEMON la solicitud y su sesión
//!                                  ▼
//!                        Presenter::show(nonce)  ── ventana nativa (src-tauri/confirm.rs)
//!                                  │                    la persona lee y confirma
//!                                  ▼
//!                        ConfirmGate::confirm(nonce, frase)
//!                                  │ misma época · sigue pendiente · plazo
//!                                  ▼
//!                        ConfirmedAction ──► broker.resolve_confirmed ──► stratumd
//! ```
//!
//! Reglas que no se rompen (`docs/dot.md` §13.9):
//!
//!  - **Lo que se enseña sale del daemon**, no del webview: herramienta,
//!    descripción (ya redactada por el anfitrión), target, entorno, sesión y
//!    directorio se leen con `approvals.list` y `sessions.get` por la conexión
//!    principal. El webview solo dice **qué** id quiere resolver; si miente
//!    sobre lo que hay detrás, la ventana enseña lo de verdad.
//!  - **Una confirmación a la vez.** Con una abierta, otra petición se rechaza
//!    (no se sustituye la ventana bajo el cursor de nadie), y tras cancelar hay
//!    una pausa corta antes de abrir otra.
//!  - **Nunca se confirma sola.** Solo [`ConfirmGate::confirm`] con el `nonce`
//!    de la ventana abierta, después de [`ConfirmTimings::arm_delay`] desde
//!    que se enseñó, y una sola vez.
//!  - **Caduca** por plazo, al bloquearse o cambiar el desbloqueo (época), al
//!    cambiar o perderse el daemon, si la solicitud se resuelve en otro sitio o
//!    su sesión desaparece, y al cerrar Dot. Caducada, no se envía nada.
//!  - Antes de entregar la confirmación se vuelve a preguntar al daemon si la
//!    solicitud sigue pendiente. Aun así, quien arbitra es el daemon: si otro
//!    llega antes entre medias, contesta `ALREADY_RESOLVED`.
//!  - En el log, qué y sobre qué id; nunca la frase, las respuestas ni el plan.
//!
//! El rechazo (denegar, omitir, rechazar el plan) **no** pasa por aquí
//! ([`ApproverAction::needs_confirmation`]).

use serde::Serialize;
use serde_json::Value;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::oneshot;
use tokio::time::Instant;

use crate::approver::{
    ApproverAction, ApproverHandle, ApproverStatus, ConfirmedAction, LockReason, QuestionAnswer,
    MAX_ANSWER_CHARS, MAX_PHRASE_CHARS,
};
use crate::link::LinkHandle;
use crate::log::Logger;
use crate::state::{CallAction, CommandError, CommandErrorKind, DotEvent};

/// Texto que se enseña de cada campo, como mucho.
const MAX_FIELD_CHARS: usize = 512;
const MAX_DESCRIPTION_CHARS: usize = 4_000;
const MAX_PATH_CHARS: usize = 4_096;
const MAX_PLAN_STEPS: usize = 40;

#[derive(Debug, Clone)]
pub struct ConfirmTimings {
    /// Cuánto puede estar abierta una confirmación.
    pub ttl: Duration,
    /// Desde que se enseña hasta que se puede confirmar: un doble clic o un
    /// clic que iba a otra cosa no aprueba nada.
    pub arm_delay: Duration,
    /// Tras cancelar o caducar, cuánto hasta poder abrir otra.
    pub cooldown: Duration,
}

impl Default for ConfirmTimings {
    fn default() -> Self {
        Self {
            ttl: Duration::from_secs(120),
            arm_delay: Duration::from_millis(800),
            cooldown: Duration::from_secs(1),
        }
    }
}

/// Por qué una confirmación no llegó a confirmarse. Va en `CommandError.reason`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CancelReason {
    /// La persona la canceló (o cerró la ventana).
    Cancelled,
    /// Venció su plazo.
    Expired,
    /// La autoridad se bloqueó, venció o es otra (otro desbloqueo).
    Locked,
    /// El daemon es otro, o su endpoint cambió.
    DaemonChanged,
    /// Se perdió la conexión con el daemon.
    Disconnected,
    /// La solicitud se resolvió en otro sitio (la terminal, otro cliente, su plazo).
    ResolvedElsewhere,
    /// Su sesión ya no está.
    SessionGone,
    /// Dot se cierra.
    Closing,
}

impl CancelReason {
    pub fn name(self) -> &'static str {
        match self {
            CancelReason::Cancelled => "cancelled",
            CancelReason::Expired => "expired",
            CancelReason::Locked => "locked",
            CancelReason::DaemonChanged => "daemon-changed",
            CancelReason::Disconnected => "disconnected",
            CancelReason::ResolvedElsewhere => "resolved-elsewhere",
            CancelReason::SessionGone => "session-gone",
            CancelReason::Closing => "closing",
        }
    }

    fn message(self) -> &'static str {
        match self {
            CancelReason::Cancelled => "Not confirmed. Nothing was sent.",
            CancelReason::Expired => "The confirmation expired. Nothing was sent.",
            CancelReason::Locked => {
                "Approval authority was locked before you confirmed. Nothing was sent."
            }
            CancelReason::DaemonChanged => {
                "The Stratum daemon changed before you confirmed. Nothing was sent."
            }
            CancelReason::Disconnected => {
                "The connection with the Stratum daemon was lost before you confirmed. Nothing was sent."
            }
            CancelReason::ResolvedElsewhere => {
                "The request was resolved elsewhere before you confirmed. Nothing was sent."
            }
            CancelReason::SessionGone => "The session ended before you confirmed. Nothing was sent.",
            CancelReason::Closing => "Stratum Dot is closing. Nothing was sent.",
        }
    }
}

pub fn not_confirmed(reason: CancelReason) -> CommandError {
    CommandError {
        kind: CommandErrorKind::NotConfirmed,
        code: None,
        reason: Some(reason.name().into()),
        message: reason.message().into(),
    }
}

/// La sesión de la solicitud, como la publica el daemon.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionFacts {
    pub id: String,
    pub title: Option<String>,
    pub agent: Option<String>,
    pub model: Option<String>,
    pub cwd: Option<String>,
    /// `daemon` · `peer`.
    pub host: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalFacts {
    pub tool: String,
    /// Ya redactada por el anfitrión: los parámetros crudos no viajan.
    pub description: String,
    pub target: Option<String>,
    pub environment: Option<String>,
    pub reason: Option<String>,
    pub forced: bool,
    /// Hay que teclearla exacta en la ventana de confirmación.
    pub confirm_phrase: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AnswerFacts {
    pub question: String,
    pub answer: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanFacts {
    pub summary: String,
    pub steps: Vec<String>,
    /// Pasos que no se enseñan (por encima de [`MAX_PLAN_STEPS`]).
    pub more_steps: usize,
}

/// Lo que enseña la ventana de confirmación. Sale del daemon (salvo las
/// respuestas, que son lo que la persona va a enviar). Sin credenciales.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfirmationView {
    /// `approval` · `question` · `plan`.
    pub kind: &'static str,
    /// El botón: `Approve`, `Allow for this session`, `Send answers`, `Approve plan`.
    pub action: &'static str,
    pub request_id: String,
    pub run_id: Option<String>,
    pub session: SessionFacts,
    pub approval: Option<ApprovalFacts>,
    pub answers: Vec<AnswerFacts>,
    pub plan: Option<PlanFacts>,
    /// Avisos que la persona tiene que leer (qué abarca `allow-all`, etc.).
    pub notes: Vec<String>,
    /// Hasta cuándo vale (ms Unix, reloj local).
    pub expires_at: u64,
    /// Cuánto tarda en poder confirmarse desde que se enseña (ms).
    pub arm_ms: u64,
}

/// Quien enseña la confirmación a la persona: la ventana nativa en la app,
/// stdout en `dot-probe`. Lo que enseña lo lee de [`ConfirmGate::view`].
pub trait Presenter: Send + Sync {
    fn show(&self, nonce: &str) -> Result<(), String>;
    fn close(&self);
}

/// Por qué `confirm` no entregó la confirmación.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfirmFailure {
    pub message: String,
    /// `true`: la ventana sigue abierta y se puede corregir (la frase).
    pub keep_open: bool,
}

enum Outcome {
    Confirmed(ConfirmedAction),
    Cancelled(CancelReason),
}

struct Ticket {
    nonce: String,
    view: ConfirmationView,
    action: ApproverAction,
    epoch: u64,
    shown_at: Option<Instant>,
    deadline: Instant,
    reply: oneshot::Sender<Outcome>,
    /// Comprobando con el daemon antes de entregarla.
    confirming: bool,
}

#[derive(Default)]
struct GateState {
    ticket: Option<Ticket>,
    cooldown_until: Option<Instant>,
}

/// Ver el módulo. Una por Dot.
pub struct ConfirmGate {
    state: Mutex<GateState>,
    timings: ConfirmTimings,
    logger: Logger,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 128 bits del generador del sistema operativo. Sin él no se abre nada.
fn new_nonce() -> Option<String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).ok()?;
    Some(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

fn clip(text: &str, max: usize) -> String {
    let mut out: String = text.chars().take(max).collect();
    if text.chars().count() > max {
        out.push('…');
    }
    out
}

fn field(value: &Value, key: &str, max: usize) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(|s| clip(s, max))
}

fn not_pending() -> CommandError {
    CommandError {
        kind: CommandErrorKind::Rejected,
        code: Some("NOT_FOUND".into()),
        reason: None,
        message: "This request is no longer pending for this session. Nothing was sent.".into(),
    }
}

fn locked() -> CommandError {
    CommandError::new(
        CommandErrorKind::NotSent,
        "Approval authority is locked. Unlock it to resolve requests from Dot.",
    )
}

/// Qué lista de `approvals.list` y qué tipo de solicitud corresponde a una acción.
fn kind_of(action: &ApproverAction) -> (&'static str, &'static str) {
    match action {
        ApproverAction::Approve { .. } | ApproverAction::Deny { .. } => ("approvals", "approval"),
        ApproverAction::AnswerQuestions { .. } => ("questions", "question"),
        ApproverAction::DecidePlan { .. } => ("plans", "plan"),
    }
}

/// La solicitud de `action` en un resultado de `approvals.list` (o en una foto,
/// que tiene las mismas tres listas), **de esa sesión**.
fn find_request<'a>(listing: &'a Value, action: &ApproverAction) -> Option<&'a Value> {
    let (list, _) = kind_of(action);
    listing.get(list)?.as_array()?.iter().find(|item| {
        item.get("id").and_then(Value::as_str) == Some(action.request_id())
            && item.get("sessionId").and_then(Value::as_str) == Some(action.session_id())
    })
}

fn bad_answers(message: &str) -> CommandError {
    CommandError::new(CommandErrorKind::Invalid, message)
}

/// Las respuestas **como las aplicará el anfitrión** (`checkQuestionAnswers` de
/// `protocol/resolve.ts`, la regla del contrato): una por pregunta y en orden,
/// con el texto de la pregunta del daemon y, si se eligió una opción, su
/// etiqueta del daemon. Así lo que se enseña es exactamente lo que se envía: el
/// webview no puede enseñar una pregunta o una etiqueta y mandar otra opción.
pub fn canonical_answers(
    questions: &[Value],
    answers: &[QuestionAnswer],
) -> Result<Vec<QuestionAnswer>, CommandError> {
    if answers.len() != questions.len() {
        return Err(bad_answers("These answers do not match the questions."));
    }
    let mut out = Vec::with_capacity(answers.len());
    for (q, a) in questions.iter().zip(answers) {
        let question = q
            .get("question")
            .and_then(Value::as_str)
            .ok_or_else(|| bad_answers("These answers do not match the questions."))?
            .to_string();
        let options: Vec<(&str, &str)> = q
            .get("options")
            .and_then(Value::as_array)
            .map(|list| {
                list.iter()
                    .filter_map(|o| Some((o.get("id")?.as_str()?, o.get("label")?.as_str()?)))
                    .collect()
            })
            .unwrap_or_default();
        let custom = q.get("allowCustom").and_then(Value::as_bool) == Some(true);
        if let Some(id) = &a.option_id {
            let Some((id, label)) = options.iter().find(|(o, _)| o == id) else {
                return Err(bad_answers(
                    "An answer chooses an option that does not exist.",
                ));
            };
            out.push(QuestionAnswer {
                question,
                answer: label.to_string(),
                option_id: Some(id.to_string()),
            });
            continue;
        }
        let text = a.answer.trim();
        let matching: Vec<_> = options.iter().filter(|(_, l)| *l == text).collect();
        if let [(id, label)] = matching.as_slice() {
            out.push(QuestionAnswer {
                question,
                answer: label.to_string(),
                option_id: Some(id.to_string()),
            });
            continue;
        }
        if !options.is_empty() && !custom {
            return Err(bad_answers("An answer must be one of the options."));
        }
        if text.is_empty() {
            return Err(bad_answers("An answer is empty."));
        }
        if text.chars().count() > MAX_ANSWER_CHARS {
            return Err(bad_answers("An answer is too long."));
        }
        out.push(QuestionAnswer {
            question,
            answer: text.to_string(),
            option_id: None,
        });
    }
    Ok(out)
}

/// Construye lo que se va a enseñar con lo que dijo el daemon, y la acción que
/// se enviará si se confirma (las respuestas, ya canónicas). Puro.
pub fn build_view(
    action: &ApproverAction,
    listing: &Value,
    snapshot: &Value,
    expires_at: u64,
    arm_ms: u64,
) -> Result<(ConfirmationView, ApproverAction), CommandError> {
    let mut send = action.clone();
    let item = find_request(listing, action).ok_or_else(not_pending)?;
    if let Some(status) = item.get("status").and_then(Value::as_str) {
        if status != "pending" {
            return Err(not_pending());
        }
    }
    let session = snapshot.get("session").unwrap_or(&Value::Null);
    let session = SessionFacts {
        id: action.session_id().to_string(),
        title: field(session, "title", MAX_FIELD_CHARS),
        agent: field(session, "agent", MAX_FIELD_CHARS),
        model: field(session, "model", MAX_FIELD_CHARS),
        cwd: field(session, "cwd", MAX_PATH_CHARS),
        // Quién aloja la sesión (`daemon` · `peer`), por puntero: el nombre del
        // rol de anfitrión no aparece en el lado nativo (test de arquitectura).
        host: session
            .pointer("/host/kind")
            .and_then(Value::as_str)
            .map(|s| clip(s, 32)),
    };
    let (_, kind) = kind_of(action);
    let mut view = ConfirmationView {
        kind,
        action: "Approve",
        request_id: action.request_id().to_string(),
        run_id: field(item, "runId", MAX_FIELD_CHARS),
        session,
        approval: None,
        answers: Vec::new(),
        plan: None,
        notes: Vec::new(),
        expires_at,
        arm_ms,
    };
    match action {
        ApproverAction::Approve { for_session, .. } => {
            if item.get("resolvable").and_then(Value::as_str) == Some("origin") {
                return Err(CommandError {
                    kind: CommandErrorKind::Rejected,
                    code: Some("UNAVAILABLE".into()),
                    reason: Some("host-unavailable".into()),
                    message: "This request can only be resolved in its terminal.".into(),
                });
            }
            let forced = item.get("forced").and_then(Value::as_bool).unwrap_or(false);
            // Sin recortar: es lo que hay que teclear y lo que se envía.
            let confirm_phrase = item
                .get("confirmPhrase")
                .and_then(Value::as_str)
                .filter(|p| !p.is_empty())
                .map(str::to_string);
            if confirm_phrase
                .as_ref()
                .is_some_and(|p| p.chars().count() > MAX_PHRASE_CHARS)
            {
                return Err(CommandError::new(
                    CommandErrorKind::Invalid,
                    "This request asks for a confirmation phrase Dot cannot send. Resolve it in its terminal.",
                ));
            }
            if *for_session && (forced || confirm_phrase.is_some()) {
                return Err(CommandError::new(
                    CommandErrorKind::Invalid,
                    "“Allow for this session” is not available for this request.",
                ));
            }
            let environment = item.get("environment").and_then(|e| {
                let name = field(e, "name", MAX_FIELD_CHARS)?;
                Some(match field(e, "tier", 64) {
                    Some(tier) => format!("{name} ({tier})"),
                    None => name,
                })
            });
            view.approval = Some(ApprovalFacts {
                tool: field(item, "tool", MAX_FIELD_CHARS).unwrap_or_else(|| "?".into()),
                description: field(item, "description", MAX_DESCRIPTION_CHARS).unwrap_or_default(),
                target: field(item, "target", MAX_FIELD_CHARS),
                environment,
                reason: field(item, "reason", MAX_FIELD_CHARS),
                forced,
                confirm_phrase,
            });
            if *for_session {
                view.action = "Allow for this session";
                view.notes.push(
                    "This approves this request and the later ones of this session only. It does not change any configuration, and requests required by policy keep asking.".into(),
                );
            }
            if forced {
                view.notes
                    .push("Required by an environment policy: approve one at a time.".into());
            }
        }
        ApproverAction::AnswerQuestions {
            session_id,
            request_id,
            answers: Some(answers),
        } => {
            let questions = item
                .get("questions")
                .and_then(Value::as_array)
                .map(Vec::as_slice)
                .unwrap_or(&[]);
            let canonical = canonical_answers(questions, answers)?;
            view.action = "Send answers";
            view.answers = canonical
                .iter()
                .map(|a| AnswerFacts {
                    question: clip(&a.question, MAX_FIELD_CHARS),
                    answer: a.answer.clone(),
                })
                .collect();
            send = ApproverAction::AnswerQuestions {
                session_id: session_id.clone(),
                request_id: request_id.clone(),
                answers: Some(canonical),
            };
        }
        ApproverAction::DecidePlan { approve: true, .. } => {
            let plan = item.get("plan").unwrap_or(&Value::Null);
            let steps: Vec<&Value> = plan
                .get("steps")
                .and_then(Value::as_array)
                .map(|s| s.iter().collect())
                .unwrap_or_default();
            view.action = "Approve plan";
            view.plan = Some(PlanFacts {
                summary: field(plan, "summary", MAX_DESCRIPTION_CHARS).unwrap_or_default(),
                steps: steps
                    .iter()
                    .take(MAX_PLAN_STEPS)
                    .map(|s| field(s, "title", MAX_FIELD_CHARS).unwrap_or_default())
                    .collect(),
                more_steps: steps.len().saturating_sub(MAX_PLAN_STEPS),
            });
        }
        // Lo negativo no se confirma.
        _ => {
            return Err(CommandError::new(
                CommandErrorKind::Invalid,
                "This does not need a confirmation.",
            ))
        }
    }
    Ok((view, send))
}

/// Quita la confirmación si sigue siendo la suya y cierra lo que se enseñaba,
/// también si quien esperaba se fue (el comando se canceló).
struct Guard<'a> {
    gate: &'a ConfirmGate,
    nonce: String,
    presenter: &'a dyn Presenter,
}

impl Drop for Guard<'_> {
    fn drop(&mut self) {
        self.gate.end(&self.nonce, None);
        self.presenter.close();
    }
}

impl ConfirmGate {
    pub fn new(timings: ConfirmTimings, logger: Logger) -> Self {
        Self {
            state: Mutex::new(GateState::default()),
            timings,
            logger,
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, GateState> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// ¿Hay una confirmación abierta?
    pub fn is_open(&self) -> bool {
        self.lock().ticket.is_some()
    }

    /// El `nonce` de la confirmación abierta (para servir su página).
    pub fn current_nonce(&self) -> Option<String> {
        self.lock().ticket.as_ref().map(|t| t.nonce.clone())
    }

    /// Lo que enseñar de la confirmación con ese `nonce`, si sigue abierta.
    pub fn view(&self, nonce: &str) -> Option<ConfirmationView> {
        let state = self.lock();
        let ticket = state.ticket.as_ref().filter(|t| t.nonce == nonce)?;
        (Instant::now() < ticket.deadline).then(|| ticket.view.clone())
    }

    /// La ventana ya enseña la solicitud (se sirvió su página): el `arm_delay`
    /// vuelve a contar desde aquí.
    pub fn shown(&self, nonce: &str) {
        let mut state = self.lock();
        if let Some(ticket) = state.ticket.as_mut().filter(|t| t.nonce == nonce) {
            ticket.shown_at = Some(Instant::now());
        }
    }

    /// Termina la confirmación `nonce` (si sigue abierta) con `outcome`, o
    /// soltándola sin más (`None`: quien esperaba ya no está).
    fn end(&self, nonce: &str, outcome: Option<Outcome>) -> bool {
        let ticket = {
            let mut state = self.lock();
            if state.ticket.as_ref().map(|t| t.nonce.as_str()) != Some(nonce) {
                return false;
            }
            let ticket = state.ticket.take();
            if !matches!(outcome, Some(Outcome::Confirmed(_))) {
                state.cooldown_until = Some(Instant::now() + self.timings.cooldown);
            }
            ticket
        };
        let Some(ticket) = ticket else { return false };
        if let Some(outcome) = outcome {
            match &outcome {
                Outcome::Confirmed(_) => self.logger.info(&format!(
                    "confirm: confirmed {} request={}",
                    ticket.action.name(),
                    ticket.view.request_id
                )),
                Outcome::Cancelled(reason) => self.logger.info(&format!(
                    "confirm: not confirmed ({}) request={}",
                    reason.name(),
                    ticket.view.request_id
                )),
            }
            let _ = ticket.reply.send(outcome);
        }
        true
    }

    /// Cancela la abierta, sea cual sea, por `reason`.
    pub fn invalidate(&self, reason: CancelReason) {
        if let Some(nonce) = self.current_nonce() {
            self.end(&nonce, Some(Outcome::Cancelled(reason)));
        }
    }

    /// La persona canceló (o cerró la ventana) la confirmación `nonce`.
    pub fn cancel(&self, nonce: &str) {
        self.end(nonce, Some(Outcome::Cancelled(CancelReason::Cancelled)));
    }

    /// Lo que pasa en Dot que puede dejar sin sentido la confirmación abierta.
    /// Se llama con cada [`DotEvent`] (de la conexión principal y del broker);
    /// solo mira, sin esperar a nada.
    pub fn on_event(&self, event: &DotEvent) {
        let (session_id, request_id, list) = {
            let state = self.lock();
            let Some(ticket) = state.ticket.as_ref() else {
                return;
            };
            (
                ticket.action.session_id().to_string(),
                ticket.view.request_id.clone(),
                kind_of(&ticket.action).0,
            )
        };
        let reason = match event {
            DotEvent::Approver { status } => match status {
                ApproverStatus::Ready { .. } => None,
                ApproverStatus::Locked {
                    reason: LockReason::DaemonChanged,
                } => Some(CancelReason::DaemonChanged),
                _ => Some(CancelReason::Locked),
            },
            DotEvent::Connection { state } if !state.is_connected() => {
                Some(CancelReason::Disconnected)
            }
            DotEvent::Sessions { session_ids, .. } if !session_ids.contains(&session_id) => {
                Some(CancelReason::SessionGone)
            }
            DotEvent::Snapshot {
                session_id: id,
                snapshot,
            } if *id == session_id => {
                let still = snapshot
                    .get(list)
                    .and_then(Value::as_array)
                    .is_some_and(|items| {
                        items
                            .iter()
                            .any(|i| i.get("id").and_then(Value::as_str) == Some(&request_id))
                    });
                (!still).then_some(CancelReason::ResolvedElsewhere)
            }
            DotEvent::Events {
                session_id: id,
                events,
            } if *id == session_id => events.iter().find_map(|event| {
                let kind = event.get("type").and_then(Value::as_str)?;
                let data = event.get("data");
                let id_of = |key: &str| data.and_then(|d| d.get(key)).and_then(Value::as_str);
                match kind {
                    "approval.resolved" if id_of("approvalId") == Some(&request_id) => {
                        Some(CancelReason::ResolvedElsewhere)
                    }
                    "question.resolved" | "plan.resolved"
                        if id_of("requestId") == Some(&request_id) =>
                    {
                        Some(CancelReason::ResolvedElsewhere)
                    }
                    "session.closed" => Some(CancelReason::SessionGone),
                    _ => None,
                }
            }),
            _ => None,
        };
        if let Some(reason) = reason {
            self.invalidate(reason);
        }
    }

    /// Lee del daemon la solicitud y su sesión, y arma lo que se enseñará.
    async fn fetch_view(
        &self,
        link: &LinkHandle,
        action: &ApproverAction,
    ) -> Result<(ConfirmationView, ApproverAction), CommandError> {
        let session_id = action.session_id().to_string();
        let unreadable = |_| {
            CommandError::new(
                CommandErrorKind::NotSent,
                "Could not read the request from the Stratum daemon. Nothing was sent.",
            )
        };
        let listing = link
            .call(CallAction::ListPending {
                session_id: session_id.clone(),
            })
            .await
            .map_err(unreadable)?;
        let session = link
            .call(CallAction::GetSession { session_id })
            .await
            .map_err(unreadable)?;
        let snapshot = session.get("snapshot").cloned().unwrap_or(Value::Null);
        let expires_at = now_ms() + self.timings.ttl.as_millis() as u64;
        build_view(
            action,
            &listing,
            &snapshot,
            expires_at,
            self.timings.arm_delay.as_millis() as u64,
        )
    }

    /// Pide a la persona que confirme `action` y espera a que lo haga. Solo
    /// devuelve una [`ConfirmedAction`] si confirmó en la superficie nativa;
    /// cualquier otra cosa es un error y no se envía nada.
    pub async fn request(
        &self,
        link: &LinkHandle,
        broker: &ApproverHandle,
        presenter: &dyn Presenter,
        action: ApproverAction,
    ) -> Result<ConfirmedAction, CommandError> {
        if !action.needs_confirmation() {
            return Err(CommandError::new(
                CommandErrorKind::Invalid,
                "This does not need a confirmation.",
            ));
        }
        let epoch = broker.ready_epoch().ok_or_else(locked)?;
        self.free()?;
        // Lo que se enseña y lo que se enviará salen de lo mismo (respuestas canónicas).
        let (view, action) = self.fetch_view(link, &action).await?;
        // Mientras se leía, pudo bloquearse.
        if broker.ready_epoch() != Some(epoch) {
            return Err(not_confirmed(CancelReason::Locked));
        }
        let nonce = new_nonce().ok_or_else(|| {
            CommandError::new(
                CommandErrorKind::NotSent,
                "Could not open the confirmation (no system randomness).",
            )
        })?;
        let (reply, outcome) = oneshot::channel();
        {
            let mut state = self.lock();
            if state.ticket.is_some() {
                return Err(another_open());
            }
            self.logger.info(&format!(
                "confirm: opened {} request={}",
                action.name(),
                view.request_id
            ));
            state.ticket = Some(Ticket {
                nonce: nonce.clone(),
                view,
                action,
                epoch,
                shown_at: None,
                deadline: Instant::now() + self.timings.ttl,
                reply,
                confirming: false,
            });
        }
        let _guard = Guard {
            gate: self,
            nonce: nonce.clone(),
            presenter,
        };
        if presenter.show(&nonce).is_err() {
            return Err(CommandError::new(
                CommandErrorKind::NotSent,
                "Could not open the confirmation window. Nothing was sent.",
            ));
        }
        if let Some(ticket) = self.lock().ticket.as_mut().filter(|t| t.nonce == nonce) {
            ticket.shown_at.get_or_insert_with(Instant::now);
        }
        let outcome = tokio::select! {
            outcome = outcome => outcome.unwrap_or(Outcome::Cancelled(CancelReason::Closing)),
            _ = tokio::time::sleep(self.timings.ttl) => {
                self.end(&nonce, Some(Outcome::Cancelled(CancelReason::Expired)));
                Outcome::Cancelled(CancelReason::Expired)
            }
        };
        match outcome {
            Outcome::Confirmed(confirmed) => Ok(confirmed),
            Outcome::Cancelled(reason) => Err(not_confirmed(reason)),
        }
    }

    fn free(&self) -> Result<(), CommandError> {
        let state = self.lock();
        if state.ticket.is_some() {
            return Err(another_open());
        }
        if state.cooldown_until.is_some_and(|t| Instant::now() < t) {
            return Err(CommandError::new(
                CommandErrorKind::NotSent,
                "Wait a moment before asking for another confirmation.",
            ));
        }
        Ok(())
    }

    /// La persona confirmó en la ventana `nonce`. `phrase` es lo que tecleó
    /// (solo cuenta si la solicitud pide frase). Se vuelve a comprobar todo y,
    /// si vale, se entrega la [`ConfirmedAction`] a quien la pidió.
    pub async fn confirm(
        &self,
        link: &LinkHandle,
        broker: &ApproverHandle,
        nonce: &str,
        phrase: Option<String>,
    ) -> Result<(), ConfirmFailure> {
        let closed = |message: &str| ConfirmFailure {
            message: message.into(),
            keep_open: false,
        };
        let (action, epoch) = {
            let mut state = self.lock();
            let Some(ticket) = state.ticket.as_mut().filter(|t| t.nonce == nonce) else {
                return Err(closed("This confirmation is no longer open."));
            };
            if ticket.confirming {
                return Err(ConfirmFailure {
                    message: "Already confirming…".into(),
                    keep_open: true,
                });
            }
            let now = Instant::now();
            if now >= ticket.deadline {
                drop(state);
                self.end(nonce, Some(Outcome::Cancelled(CancelReason::Expired)));
                return Err(closed(CancelReason::Expired.message()));
            }
            let armed = ticket
                .shown_at
                .is_some_and(|at| now.duration_since(at) >= self.timings.arm_delay);
            if !armed {
                return Err(ConfirmFailure {
                    message: "Read the request before confirming.".into(),
                    keep_open: true,
                });
            }
            let expected = ticket
                .view
                .approval
                .as_ref()
                .and_then(|a| a.confirm_phrase.clone());
            let mut action = ticket.action.clone();
            if let ApproverAction::Approve { phrase: slot, .. } = &mut action {
                match &expected {
                    Some(expected) if phrase.as_deref() != Some(expected.as_str()) => {
                        return Err(ConfirmFailure {
                            message: "The phrase does not match. Nothing was approved.".into(),
                            keep_open: true,
                        });
                    }
                    Some(expected) => *slot = Some(expected.clone()),
                    None => *slot = None,
                }
            }
            ticket.confirming = true;
            (action, ticket.epoch)
        };
        // Lo que pudo cambiar mientras la ventana estaba abierta.
        if broker.ready_epoch() != Some(epoch) {
            self.end(nonce, Some(Outcome::Cancelled(CancelReason::Locked)));
            return Err(closed(CancelReason::Locked.message()));
        }
        let listing = match link
            .call(CallAction::ListPending {
                session_id: action.session_id().to_string(),
            })
            .await
        {
            Ok(listing) => listing,
            Err(_) => {
                self.end(nonce, Some(Outcome::Cancelled(CancelReason::Disconnected)));
                return Err(closed(CancelReason::Disconnected.message()));
            }
        };
        if find_request(&listing, &action).is_none() {
            self.end(
                nonce,
                Some(Outcome::Cancelled(CancelReason::ResolvedElsewhere)),
            );
            return Err(closed(CancelReason::ResolvedElsewhere.message()));
        }
        if broker.ready_epoch() != Some(epoch) {
            self.end(nonce, Some(Outcome::Cancelled(CancelReason::Locked)));
            return Err(closed(CancelReason::Locked.message()));
        }
        if self.end(
            nonce,
            Some(Outcome::Confirmed(ConfirmedAction::new(action, epoch))),
        ) {
            Ok(())
        } else {
            // Se canceló mientras se comprobaba (bloqueo, otro sitio, cierre).
            Err(closed("This confirmation is no longer open."))
        }
    }
}

fn another_open() -> CommandError {
    CommandError::new(
        CommandErrorKind::NotSent,
        "Another confirmation is open. Finish or cancel it first.",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::approver::QuestionAnswer;
    use serde_json::json;

    fn approve(session: &str, id: &str, for_session: bool) -> ApproverAction {
        ApproverAction::Approve {
            session_id: session.into(),
            approval_id: id.into(),
            phrase: None,
            for_session,
        }
    }

    fn listing() -> Value {
        json!({
            "approvals": [{
                "id": "apr_1", "kind": "tool", "sessionId": "ses_a", "runId": "run_1",
                "tool": "exec", "description": "rm -rf build/", "target": "prod-db",
                "environment": { "name": "prod", "tier": "production" },
                "forced": false, "resolvable": "anywhere", "status": "pending",
                "requestedAt": 1, "expiresAt": null
            }, {
                "id": "apr_2", "kind": "tool", "sessionId": "ses_a", "runId": "run_1",
                "tool": "exec", "description": "deploy", "forced": true,
                "confirmPhrase": "prod", "resolvable": "anywhere", "status": "pending",
                "requestedAt": 1, "expiresAt": null
            }, {
                "id": "apr_3", "kind": "tool", "sessionId": "ses_a", "runId": "run_1",
                "tool": "exec", "description": "x", "forced": false,
                "resolvable": "origin", "status": "pending", "requestedAt": 1, "expiresAt": null
            }],
            "questions": [{
                "id": "q_1", "sessionId": "ses_a", "runId": "run_1",
                "questions": [{ "question": "¿Cuál?" }], "requestedAt": 1, "expiresAt": null
            }],
            "plans": [{
                "id": "p_1", "sessionId": "ses_a", "runId": "run_1",
                "plan": { "summary": "Migrar", "steps": [{ "id": "s1", "title": "Copiar", "status": "pending" }] },
                "requestedAt": 1, "expiresAt": null
            }]
        })
    }

    fn snapshot() -> Value {
        json!({ "session": {
            "id": "ses_a", "title": "tarea", "agent": "general", "model": "m",
            "cwd": "/work/proj", "host": { "kind": "peer" }
        }})
    }

    #[test]
    fn lo_que_se_ensena_sale_del_daemon() {
        let view = build_view(
            &approve("ses_a", "apr_1", false),
            &listing(),
            &snapshot(),
            9,
            800,
        )
        .unwrap()
        .0;
        assert_eq!(view.kind, "approval");
        assert_eq!(view.action, "Approve");
        assert_eq!(view.session.cwd.as_deref(), Some("/work/proj"));
        assert_eq!(view.session.host.as_deref(), Some("peer"));
        let approval = view.approval.unwrap();
        assert_eq!(approval.tool, "exec");
        assert_eq!(approval.description, "rm -rf build/");
        assert_eq!(approval.target.as_deref(), Some("prod-db"));
        assert_eq!(approval.environment.as_deref(), Some("prod (production)"));
        assert_eq!(view.expires_at, 9);
    }

    #[test]
    fn un_id_de_otra_sesion_no_existe() {
        let err = build_view(
            &approve("ses_b", "apr_1", false),
            &listing(),
            &snapshot(),
            0,
            0,
        )
        .unwrap_err();
        assert_eq!(err.code.as_deref(), Some("NOT_FOUND"));
        // Ni un tipo cruzado: un id de aprobación no es una pregunta.
        let err = build_view(
            &ApproverAction::AnswerQuestions {
                session_id: "ses_a".into(),
                request_id: "apr_1".into(),
                answers: Some(vec![QuestionAnswer {
                    question: "q".into(),
                    answer: "a".into(),
                    option_id: None,
                }]),
            },
            &listing(),
            &snapshot(),
            0,
            0,
        )
        .unwrap_err();
        assert_eq!(err.code.as_deref(), Some("NOT_FOUND"));
    }

    #[test]
    fn allow_all_no_vale_con_politica_ni_frase_y_origin_no_se_resuelve_aqui() {
        let err = build_view(
            &approve("ses_a", "apr_2", true),
            &listing(),
            &snapshot(),
            0,
            0,
        )
        .unwrap_err();
        assert_eq!(err.kind, CommandErrorKind::Invalid);
        let err = build_view(
            &approve("ses_a", "apr_3", false),
            &listing(),
            &snapshot(),
            0,
            0,
        )
        .unwrap_err();
        assert_eq!(err.reason.as_deref(), Some("host-unavailable"));
        let view = build_view(
            &approve("ses_a", "apr_1", true),
            &listing(),
            &snapshot(),
            0,
            0,
        )
        .unwrap()
        .0;
        assert_eq!(view.action, "Allow for this session");
        assert!(!view.notes.is_empty());
        let view = build_view(
            &approve("ses_a", "apr_2", false),
            &listing(),
            &snapshot(),
            0,
            0,
        )
        .unwrap()
        .0;
        assert_eq!(
            view.approval.unwrap().confirm_phrase.as_deref(),
            Some("prod")
        );
    }

    #[test]
    fn respuestas_y_plan() {
        let view = build_view(
            &ApproverAction::AnswerQuestions {
                session_id: "ses_a".into(),
                request_id: "q_1".into(),
                answers: Some(vec![QuestionAnswer {
                    question: "¿Cuál?".into(),
                    answer: "A".into(),
                    option_id: None,
                }]),
            },
            &listing(),
            &snapshot(),
            0,
            0,
        )
        .unwrap()
        .0;
        assert_eq!(view.action, "Send answers");
        assert_eq!(view.answers[0].answer, "A");
        let view = build_view(
            &ApproverAction::DecidePlan {
                session_id: "ses_a".into(),
                request_id: "p_1".into(),
                approve: true,
            },
            &listing(),
            &snapshot(),
            0,
            0,
        )
        .unwrap()
        .0;
        let plan = view.plan.unwrap();
        assert_eq!((plan.summary.as_str(), plan.steps.len()), ("Migrar", 1));
    }

    #[test]
    fn lo_que_se_ensena_de_una_respuesta_es_lo_que_se_envia() {
        let listing = json!({ "approvals": [], "plans": [], "questions": [{
            "id": "q_9", "sessionId": "ses_a", "runId": "run_1", "requestedAt": 1, "expiresAt": null,
            "questions": [{ "question": "¿Qué hago con la tabla?",
                "options": [{ "id": "keep", "label": "Conservarla" }, { "id": "drop", "label": "Borrar la tabla de producción" }] }]
        }]});
        let ask = |answers: Vec<QuestionAnswer>| ApproverAction::AnswerQuestions {
            session_id: "ses_a".into(),
            request_id: "q_9".into(),
            answers: Some(answers),
        };
        // Un webview que miente sobre la pregunta y la etiqueta, y elige otra opción.
        let (view, send) = build_view(
            &ask(vec![QuestionAnswer {
                question: "¿Seguimos en modo prueba?".into(),
                answer: "Conservarla".into(),
                option_id: Some("drop".into()),
            }]),
            &listing,
            &snapshot(),
            0,
            0,
        )
        .unwrap();
        // Se enseña lo que dice el daemon y lo que de verdad se enviará.
        assert_eq!(view.answers[0].question, "¿Qué hago con la tabla?");
        assert_eq!(view.answers[0].answer, "Borrar la tabla de producción");
        let ApproverAction::AnswerQuestions {
            answers: Some(sent),
            ..
        } = send
        else {
            panic!("answers")
        };
        assert_eq!(sent[0].answer, view.answers[0].answer);
        assert_eq!(sent[0].option_id.as_deref(), Some("drop"));
        // Una opción que no existe, texto libre sin `allowCustom` o menos respuestas: no.
        for bad in [
            vec![QuestionAnswer {
                question: "x".into(),
                answer: "x".into(),
                option_id: Some("nope".into()),
            }],
            vec![QuestionAnswer {
                question: "x".into(),
                answer: "otra cosa".into(),
                option_id: None,
            }],
            vec![],
        ] {
            let err = build_view(&ask(bad), &listing, &snapshot(), 0, 0).unwrap_err();
            assert_eq!(err.kind, CommandErrorKind::Invalid);
        }
    }

    #[test]
    fn una_frase_que_no_cabe_no_se_recorta() {
        let mut l = listing();
        l["approvals"][1]["confirmPhrase"] = json!("p".repeat(MAX_PHRASE_CHARS + 1));
        let err = build_view(&approve("ses_a", "apr_2", false), &l, &snapshot(), 0, 0).unwrap_err();
        assert_eq!(err.kind, CommandErrorKind::Invalid);
    }

    #[test]
    fn lo_largo_se_recorta_para_ensenarlo() {
        let mut l = listing();
        l["approvals"][0]["description"] = json!("x".repeat(MAX_DESCRIPTION_CHARS + 50));
        let view = build_view(&approve("ses_a", "apr_1", false), &l, &snapshot(), 0, 0)
            .unwrap()
            .0;
        assert_eq!(
            view.approval.unwrap().description.chars().count(),
            MAX_DESCRIPTION_CHARS + 1
        );
    }

    #[test]
    fn el_motivo_viaja_en_el_error() {
        let err = not_confirmed(CancelReason::ResolvedElsewhere);
        assert_eq!(err.kind, CommandErrorKind::NotConfirmed);
        assert_eq!(err.reason.as_deref(), Some("resolved-elsewhere"));
        assert_eq!(
            serde_json::to_value(CancelReason::DaemonChanged).unwrap(),
            json!("daemon-changed")
        );
    }
}
