//! La autoridad de aprobar de Dot: el **`ApproverBroker`**.
//!
//! ```text
//! webview ── dot_approve(...) ──► broker ── conexión de aprobador ──► stratumd ──► anfitrión
//!                                   ▲        roles: ["approver"]
//!     ventana de desbloqueo ── clave┘        (otra conexión, no la principal)
//! ```
//!
//! Reglas que no se rompen (`docs/dot.md` §13):
//!
//!  - **Otra conexión.** La principal ([`crate::link`]) es `operator` y no
//!    sabe aprobar; esta es `approver` y no sabe nada más: solo puede enviar
//!    [`ApproverMethod`] (saludar y resolver). Ni observar, ni conducir runs.
//!  - **Bajo demanda.** No hay conexión de aprobador hasta que la persona la
//!    desbloquea, y se suelta al bloquear, al vencer su plazo, al cerrar Dot o
//!    si se pierde. Nunca se reconecta sola: la clave no se guarda.
//!  - **La clave vive lo que dura el saludo.** Entra como [`ApproverSecret`],
//!    se escribe en el `core.hello` y se borra. Tras el saludo la autoridad es
//!    la conexión acreditada, y solo si el daemon concedió de verdad `approve`.
//!  - **Ninguna resolución se repite.** Enviada y sin respuesta, su resultado
//!    es desconocido y quien la pidió lo sabe; lo que pasó lo dirá la foto.
//!  - **El webview no ve cómo se acredita.** Solo el estado ([`ApproverStatus`]),
//!    sin datos: ni la clave, ni nada derivado de ella, ni el token del canal.
//!  - Los errores de desbloqueo son genéricos: no dicen si la clave existía,
//!    se parecía o se probó antes.

use serde::Serialize;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncReadExt, AsyncWriteExt, WriteHalf};
use tokio::sync::{mpsc, oneshot};
use tokio::time::Instant;

use crate::discovery::{self, Discovery};
use crate::framing::LineDecoder;
use crate::log::Logger;
use crate::secret::ApproverSecret;
use crate::state::{CommandError, CommandErrorKind, ConnectionState, DotEvent};
use crate::transport::{self, Stream};
use crate::wire::{self, ApproverMethod, Incoming, WireError};
use crate::{MAX_ID_CHARS, MAX_MESSAGE_BYTES, PROTOCOL_VERSION};

/// Lo que se le dice a quien no pudo desbloquear, sea cual sea el motivo de autenticación.
pub const UNLOCK_FAILED: &str = "Could not unlock approval authority.";

/// Frase tecleada de una confirmación con nombre (`LIMITS.phraseChars`).
pub const MAX_PHRASE_CHARS: usize = 256;
/// Respuestas de una tanda de preguntas (`LIMITS.answers`, `LIMITS.answerChars`).
pub const MAX_ANSWERS: usize = 8;
pub const MAX_ANSWER_CHARS: usize = 4_000;

/// Por qué el broker está bloqueado. Para decirlo, sin datos.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum LockReason {
    /// Nunca se desbloqueó desde que abrió Dot.
    Initial,
    /// La persona pulsó *Lock approvals*.
    Manual,
    /// Venció el plazo del desbloqueo.
    Expired,
    /// Se perdió la conexión de aprobador (el daemon se paró o la cerró).
    ConnectionLost,
    /// El daemon al que se acreditó ya no es el que hay.
    DaemonChanged,
}

/// Por qué no se puede desbloquear ahora.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Unavailable {
    /// Dot no está conectado al daemon.
    NotConnected,
    /// El daemon no acredita aprobadores: no hay clave configurada
    /// (`stratum approvals set-key`), o no anuncia `remote-approvals`.
    NoApproverKey,
}

/// Estado del broker: lo **único** que el webview sabe de la autoridad de aprobar.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum ApproverStatus {
    Locked {
        reason: LockReason,
    },
    /// Comprobando la clave con el daemon.
    Unlocking,
    /// Acreditado: se puede resolver. `expires_at` en ms Unix (reloj local).
    Ready {
        expires_at: u64,
    },
    Unavailable {
        reason: Unavailable,
    },
    /// El último desbloqueo falló. Se puede volver a intentar.
    Error {
        message: String,
    },
}

impl ApproverStatus {
    pub fn name(&self) -> &'static str {
        match self {
            ApproverStatus::Locked { .. } => "locked",
            ApproverStatus::Unlocking => "unlocking",
            ApproverStatus::Ready { .. } => "ready",
            ApproverStatus::Unavailable { .. } => "unavailable",
            ApproverStatus::Error { .. } => "error",
        }
    }
}

/// Una respuesta a una pregunta del agente (`ProtocolQuestionAnswer`).
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionAnswer {
    pub question: String,
    pub answer: String,
    #[serde(default)]
    pub option_id: Option<String>,
}

/// Lo que la persona decide. Siempre con la sesión de la solicitud: el daemon
/// rechaza un id que no sea de esa sesión.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ApproverAction {
    /// `for_session` = `allow-all`: el resto de **esa** sesión, nunca lo forzado.
    Approve {
        session_id: String,
        approval_id: String,
        phrase: Option<String>,
        for_session: bool,
    },
    Deny {
        session_id: String,
        approval_id: String,
    },
    /// `None` = omitir la tanda.
    AnswerQuestions {
        session_id: String,
        request_id: String,
        answers: Option<Vec<QuestionAnswer>>,
    },
    /// Aprobar el plan propuesto, tal cual, o rechazarlo. Sin edición.
    DecidePlan {
        session_id: String,
        request_id: String,
        approve: bool,
    },
}

impl ApproverAction {
    /// Para el log: qué tipo de resolución, sin contenido.
    pub fn name(&self) -> &'static str {
        match self {
            ApproverAction::Approve {
                for_session: true, ..
            } => "allow-session",
            ApproverAction::Approve { .. } => "approve",
            ApproverAction::Deny { .. } => "deny",
            ApproverAction::AnswerQuestions { answers: None, .. } => "skip-questions",
            ApproverAction::AnswerQuestions { .. } => "answer-questions",
            ApproverAction::DecidePlan { approve: true, .. } => "approve-plan",
            ApproverAction::DecidePlan { .. } => "reject-plan",
        }
    }

    fn request_id(&self) -> &str {
        match self {
            ApproverAction::Approve { approval_id, .. }
            | ApproverAction::Deny { approval_id, .. } => approval_id,
            ApproverAction::AnswerQuestions { request_id, .. }
            | ApproverAction::DecidePlan { request_id, .. } => request_id,
        }
    }
}

#[derive(Debug, Clone)]
pub struct ApproverTimings {
    /// El daemon comprueba la clave con scrypt, en cola, y retrasa el fallo 1 s.
    pub handshake_timeout: Duration,
    /// Resolver puede esperar a que un anfitrión par conteste.
    pub request_timeout: Duration,
    /// Cuánto dura un desbloqueo.
    pub unlocked_for: Duration,
    /// Tras un fallo, cuánto hay que esperar para volver a probar.
    pub retry_cooldown: Duration,
    pub connect_wait: Duration,
}

impl Default for ApproverTimings {
    fn default() -> Self {
        Self {
            handshake_timeout: Duration::from_secs(15),
            request_timeout: Duration::from_secs(20),
            unlocked_for: Duration::from_secs(10 * 60),
            retry_cooldown: Duration::from_secs(2),
            connect_wait: Duration::from_secs(2),
        }
    }
}

pub struct ApproverConfig {
    pub endpoint_dir: PathBuf,
    pub client_version: String,
    pub logger: Logger,
    pub timings: ApproverTimings,
}

type Reply = oneshot::Sender<Result<(), CommandError>>;

enum Cmd {
    Unlock(ApproverSecret, Reply),
    Lock,
    Resolve(ApproverAction, Reply),
    Main { connected: bool, approvals: bool },
    Attach,
    Shutdown,
}

struct Shared {
    status: Mutex<ApproverStatus>,
}

/// Lo que la app tiene del broker. Barato de clonar.
#[derive(Clone)]
pub struct ApproverHandle {
    tx: mpsc::UnboundedSender<Cmd>,
    shared: Arc<Shared>,
}

fn gone() -> CommandError {
    CommandError::new(CommandErrorKind::NotSent, "Stratum Dot is shutting down.")
}

impl ApproverHandle {
    pub fn status(&self) -> ApproverStatus {
        self.shared
            .status
            .lock()
            .map(|s| s.clone())
            .unwrap_or(ApproverStatus::Locked {
                reason: LockReason::Initial,
            })
    }

    /// Acredita una conexión de aprobador con esa clave. La clave se consume
    /// aquí: pase lo que pase, no sobrevive a la llamada.
    pub async fn unlock(&self, secret: ApproverSecret) -> Result<(), CommandError> {
        let (reply, answer) = oneshot::channel();
        self.tx
            .send(Cmd::Unlock(secret, reply))
            .map_err(|_| gone())?;
        answer.await.unwrap_or_else(|_| Err(gone()))
    }

    /// Suelta la autoridad: cierra la conexión de aprobador. Lo pendiente sigue
    /// pendiente; solo deja de poder resolverse desde Dot.
    pub fn lock(&self) {
        let _ = self.tx.send(Cmd::Lock);
    }

    /// Envía una resolución, **una vez**. `Ok` = el daemon (y el anfitrión de
    /// la sesión) la aceptaron; lo que cambie se ve por eventos.
    pub async fn resolve(&self, action: ApproverAction) -> Result<(), CommandError> {
        let (reply, answer) = oneshot::channel();
        self.tx
            .send(Cmd::Resolve(action, reply))
            .map_err(|_| gone())?;
        answer.await.unwrap_or_else(|_| Err(gone()))
    }

    /// Lo que dice la conexión principal: si hay daemon y si acredita aprobadores.
    pub fn observe_main(&self, state: &ConnectionState) {
        let (connected, approvals) = match state {
            ConnectionState::Connected { features, .. } => {
                (true, features.iter().any(|f| f == "remote-approvals"))
            }
            _ => (false, false),
        };
        let _ = self.tx.send(Cmd::Main {
            connected,
            approvals,
        });
    }

    /// La interfaz acaba de cargar: se le repite el estado.
    pub fn attach(&self) {
        let _ = self.tx.send(Cmd::Attach);
    }

    /// Dot se cierra: se suelta la conexión de aprobador. El daemon sigue.
    pub fn shutdown(&self) {
        let _ = self.tx.send(Cmd::Shutdown);
    }
}

/// Crea el broker. Devuelve el mango y la tarea, que quien llama lanza en su
/// runtime de tokio. `sink` recibe cada cambio de estado ([`DotEvent::Approver`]).
pub fn spawn_broker(
    config: ApproverConfig,
    sink: impl Fn(DotEvent) + Send + Sync + 'static,
) -> (
    ApproverHandle,
    impl std::future::Future<Output = ()> + Send + 'static,
) {
    let (tx, rx) = mpsc::unbounded_channel();
    let initial = ApproverStatus::Unavailable {
        reason: Unavailable::NotConnected,
    };
    let shared = Arc::new(Shared {
        status: Mutex::new(initial),
    });
    let broker = Broker {
        operation_prefix: format!(
            "dot-approver-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ),
        cfg: config,
        rx,
        sink: Box::new(sink),
        shared: shared.clone(),
        conn: None,
        main_connected: false,
        main_approvals: false,
        lock_reason: LockReason::Initial,
        failure: None,
        cooldown_until: None,
        operations: 0,
    };
    (ApproverHandle { tx, shared }, broker.run())
}

enum Phase {
    /// `core.hello` enviado; esperando a que el daemon compruebe la clave.
    Handshake {
        reply: Reply,
        deadline: Instant,
    },
    Ready {
        until: Instant,
        expires_at: u64,
    },
}

struct Conn {
    writer: WriteHalf<Stream>,
    lines: mpsc::Receiver<String>,
    _reader: AbortOnDrop,
    phase: Phase,
    /// El arranque del daemon (pid + hora) al que se acreditó.
    identity: (u32, String),
    next_id: u64,
    pending: HashMap<u64, (Reply, Instant)>,
}

struct Broker {
    cfg: ApproverConfig,
    rx: mpsc::UnboundedReceiver<Cmd>,
    sink: Box<dyn Fn(DotEvent) + Send + Sync>,
    shared: Arc<Shared>,
    conn: Option<Conn>,
    main_connected: bool,
    main_approvals: bool,
    lock_reason: LockReason,
    /// El último desbloqueo falló (y por qué, en genérico).
    failure: Option<String>,
    cooldown_until: Option<Instant>,
    operations: u64,
    operation_prefix: String,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// ¿Venció el desbloqueo? Con los dos relojes: el monotónico no avanza con el
/// equipo suspendido, y un desbloqueo no puede sobrevivir a una suspensión larga.
fn expired(until: Instant, expires_at: u64) -> bool {
    Instant::now() >= until || now_ms() >= expires_at
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.chars().count() <= MAX_ID_CHARS
}

fn invalid(message: &str) -> CommandError {
    CommandError::new(CommandErrorKind::Invalid, message)
}

fn locked() -> CommandError {
    CommandError::new(
        CommandErrorKind::NotSent,
        "Approval authority is locked. Unlock it to resolve requests from Dot.",
    )
}

fn unknown(why: &str) -> CommandError {
    CommandError::new(
        CommandErrorKind::Unknown,
        format!("{why} The result is unknown: it was not sent again. Check the request before trying again."),
    )
}

/// Método y parámetros de una resolución, o por qué no vale. Solo se comprueba
/// que quepa en el protocolo: si la respuesta vale lo deciden el daemon y el
/// anfitrión de la sesión, que son la autoridad.
fn resolve_request(
    action: &ApproverAction,
    operation_id: &str,
) -> Result<(ApproverMethod, Value), CommandError> {
    let ids = |session_id: &str, id: &str| {
        if !valid_id(session_id) {
            return Err(invalid("Invalid session id."));
        }
        if !valid_id(id) {
            return Err(invalid("Invalid request id."));
        }
        Ok(())
    };
    match action {
        ApproverAction::Approve {
            session_id,
            approval_id,
            phrase,
            for_session,
        } => {
            ids(session_id, approval_id)?;
            let mut params = json!({
                "sessionId": session_id, "approvalId": approval_id,
                "decision": if *for_session { "allow-all" } else { "approve" },
                "operationId": operation_id,
            });
            if let Some(phrase) = phrase {
                if phrase.chars().count() > MAX_PHRASE_CHARS {
                    return Err(invalid("The confirmation phrase is too long."));
                }
                params["phrase"] = Value::String(phrase.clone());
            }
            Ok((ApproverMethod::ApprovalsResolve, params))
        }
        ApproverAction::Deny {
            session_id,
            approval_id,
        } => {
            ids(session_id, approval_id)?;
            Ok((
                ApproverMethod::ApprovalsResolve,
                json!({ "sessionId": session_id, "approvalId": approval_id, "decision": "deny", "operationId": operation_id }),
            ))
        }
        ApproverAction::AnswerQuestions {
            session_id,
            request_id,
            answers,
        } => {
            ids(session_id, request_id)?;
            let answers = match answers {
                None => Value::Null,
                Some(list) => {
                    if list.len() > MAX_ANSWERS {
                        return Err(invalid("Too many answers."));
                    }
                    let mut out = Vec::with_capacity(list.len());
                    for a in list {
                        if a.question.chars().count() > MAX_ANSWER_CHARS
                            || a.answer.chars().count() > MAX_ANSWER_CHARS
                        {
                            return Err(invalid("An answer is too long."));
                        }
                        let mut item = json!({ "question": a.question, "answer": a.answer });
                        if let Some(option) = &a.option_id {
                            if !valid_id(option) {
                                return Err(invalid("Invalid option id."));
                            }
                            item["optionId"] = Value::String(option.clone());
                        }
                        out.push(item);
                    }
                    Value::Array(out)
                }
            };
            Ok((
                ApproverMethod::QuestionsAnswer,
                json!({ "sessionId": session_id, "requestId": request_id, "answers": answers, "operationId": operation_id }),
            ))
        }
        ApproverAction::DecidePlan {
            session_id,
            request_id,
            approve,
        } => {
            ids(session_id, request_id)?;
            Ok((
                ApproverMethod::PlansDecide,
                json!({
                    "sessionId": session_id, "requestId": request_id,
                    "decision": if *approve { "approve" } else { "reject" },
                    "operationId": operation_id,
                }),
            ))
        }
    }
}

enum Wake {
    Cmd(Option<Cmd>),
    Line(Option<String>),
    Tick,
}

/// Qué hacer con algo que llegó por la conexión de aprobador.
enum Step {
    Nothing,
    /// La conexión ya no vale: se cierra y se bloquea por ese motivo.
    Close(LockReason),
}

impl Broker {
    fn computed_status(&self) -> ApproverStatus {
        match &self.conn {
            Some(Conn {
                phase: Phase::Handshake { .. },
                ..
            }) => ApproverStatus::Unlocking,
            Some(Conn {
                phase: Phase::Ready { expires_at, .. },
                ..
            }) => ApproverStatus::Ready {
                expires_at: *expires_at,
            },
            None if !self.main_connected => ApproverStatus::Unavailable {
                reason: Unavailable::NotConnected,
            },
            None if !self.main_approvals => ApproverStatus::Unavailable {
                reason: Unavailable::NoApproverKey,
            },
            None => match &self.failure {
                Some(message) => ApproverStatus::Error {
                    message: message.clone(),
                },
                None => ApproverStatus::Locked {
                    reason: self.lock_reason,
                },
            },
        }
    }

    fn publish(&self, force: bool) {
        let next = self.computed_status();
        {
            let Ok(mut current) = self.shared.status.lock() else {
                return;
            };
            if *current == next && !force {
                return;
            }
            *current = next.clone();
        }
        (self.sink)(DotEvent::Approver { status: next });
    }

    async fn run(mut self) {
        let mut tick = tokio::time::interval(Duration::from_millis(250));
        loop {
            let wake = {
                let conn = &mut self.conn;
                let rx = &mut self.rx;
                tokio::select! {
                    cmd = rx.recv() => Wake::Cmd(cmd),
                    line = async {
                        match conn.as_mut() {
                            Some(conn) => conn.lines.recv().await,
                            None => std::future::pending().await,
                        }
                    } => Wake::Line(line),
                    _ = tick.tick() => Wake::Tick,
                }
            };
            let step = match wake {
                Wake::Cmd(None) | Wake::Cmd(Some(Cmd::Shutdown)) => break,
                Wake::Cmd(Some(cmd)) => self.on_cmd(cmd).await,
                Wake::Line(None) => Step::Close(LockReason::ConnectionLost),
                Wake::Line(Some(line)) => self.on_line(&line).await,
                Wake::Tick => self.on_tick(),
            };
            if let Step::Close(reason) = step {
                self.close(reason);
            }
            self.publish(false);
        }
        if self.conn.take().is_some() {
            self.cfg
                .logger
                .info("approver: connection closed (dot is quitting)");
        }
    }

    /// Cierra la conexión de aprobador. Lo que esperaba respuesta queda con
    /// resultado desconocido: no se reenvía.
    fn close(&mut self, reason: LockReason) {
        let Some(mut conn) = self.conn.take() else {
            return;
        };
        if let Phase::Handshake { reply, .. } = conn.phase {
            // Se cerró antes de saber si la clave valía.
            self.failure = Some(UNLOCK_FAILED.into());
            self.cooldown_until = Some(Instant::now() + self.cfg.timings.retry_cooldown);
            let _ = reply.send(Err(CommandError::new(
                CommandErrorKind::Rejected,
                UNLOCK_FAILED,
            )));
        }
        for (_, (reply, _)) in conn.pending.drain() {
            let _ = reply.send(Err(unknown(
                "The approval connection was lost before the daemon answered.",
            )));
        }
        self.lock_reason = reason;
        self.cfg.logger.info(&format!(
            "approver: locked ({})",
            serde_json::to_value(reason)
                .ok()
                .and_then(|v| v.as_str().map(str::to_string))
                .unwrap_or_default()
        ));
    }

    fn on_tick(&mut self) -> Step {
        let now = Instant::now();
        let Some(conn) = self.conn.as_mut() else {
            return Step::Nothing;
        };
        match &conn.phase {
            Phase::Handshake { deadline, .. } if *deadline <= now => {
                self.cfg.logger.warn("approver: unlock timed out");
                return Step::Close(LockReason::ConnectionLost);
            }
            Phase::Ready { until, expires_at } if expired(*until, *expires_at) => {
                return Step::Close(LockReason::Expired)
            }
            _ => {}
        }
        let late: Vec<u64> = conn
            .pending
            .iter()
            .filter(|(_, (_, at))| *at <= now)
            .map(|(id, _)| *id)
            .collect();
        for id in late {
            if let Some((reply, _)) = conn.pending.remove(&id) {
                let _ = reply.send(Err(unknown("The daemon did not answer in time.")));
            }
        }
        Step::Nothing
    }

    async fn on_cmd(&mut self, cmd: Cmd) -> Step {
        match cmd {
            Cmd::Shutdown => Step::Nothing,
            Cmd::Attach => {
                self.publish(true);
                Step::Nothing
            }
            Cmd::Main {
                connected,
                approvals,
            } => {
                self.main_connected = connected;
                self.main_approvals = approvals;
                Step::Nothing
            }
            Cmd::Lock => {
                self.failure = None;
                if self.conn.is_some() {
                    self.cfg.logger.info("approver: lock requested");
                    Step::Close(LockReason::Manual)
                } else {
                    Step::Nothing
                }
            }
            Cmd::Unlock(secret, reply) => {
                self.unlock(secret, reply).await;
                Step::Nothing
            }
            Cmd::Resolve(action, reply) => self.resolve(action, reply).await,
        }
    }

    async fn unlock(&mut self, secret: ApproverSecret, reply: Reply) {
        if let Some(conn) = &self.conn {
            drop(secret);
            let _ = reply.send(match conn.phase {
                Phase::Ready { .. } => Ok(()),
                Phase::Handshake { .. } => Err(CommandError::new(
                    CommandErrorKind::NotSent,
                    "Already unlocking.",
                )),
            });
            return;
        }
        // Sin bucles: tras un fallo hay que esperar un momento.
        if self
            .cooldown_until
            .is_some_and(|until| Instant::now() < until)
        {
            drop(secret);
            let _ = reply.send(Err(CommandError::new(
                CommandErrorKind::NotSent,
                "Wait a moment before trying again.",
            )));
            return;
        }
        if !self.main_connected || !self.main_approvals {
            drop(secret);
            let _ = reply.send(Err(CommandError::new(
                CommandErrorKind::NotSent,
                if self.main_connected {
                    "The Stratum daemon does not accept remote approvals: no approver key is configured."
                } else {
                    "Not connected to the Stratum daemon."
                },
            )));
            return;
        }
        self.cfg.logger.info("approver: unlock attempt");
        let endpoint = match discovery::locate(&self.cfg.endpoint_dir) {
            Discovery::Found(endpoint) => endpoint,
            _ => {
                drop(secret);
                let _ = reply.send(Err(CommandError::new(
                    CommandErrorKind::NotSent,
                    "Not connected to the Stratum daemon.",
                )));
                return;
            }
        };
        let stream =
            match transport::connect(&endpoint.ipc_path, self.cfg.timings.connect_wait).await {
                Ok(stream) => stream,
                Err(e) => {
                    drop(secret);
                    self.cfg
                        .logger
                        .warn(&format!("approver: connect failed ({:?})", e.kind()));
                    let _ = reply.send(Err(CommandError::new(
                        CommandErrorKind::NotSent,
                        "The Stratum daemon is not answering.",
                    )));
                    return;
                }
            };
        let (mut reader, mut writer) = tokio::io::split(stream);
        let (line_tx, lines) = mpsc::channel::<String>(64);
        let reader_task = tokio::spawn(async move {
            let mut decoder = LineDecoder::new(MAX_MESSAGE_BYTES);
            let mut chunk = vec![0u8; 16 * 1024];
            loop {
                let read = match reader.read(&mut chunk).await {
                    Ok(0) | Err(_) => return,
                    Ok(n) => n,
                };
                let Ok(batch) = decoder.push(&chunk[..read]) else {
                    return;
                };
                for line in batch {
                    if line_tx.send(line).await.is_err() {
                        return;
                    }
                }
            }
        });

        let mut params = Map::new();
        params.insert("protocol".into(), json!(PROTOCOL_VERSION));
        params.insert("token".into(), json!(endpoint.token.expose()));
        params.insert(
            "client".into(),
            json!({ "kind": "dot", "name": "stratum-dot-approver", "version": self.cfg.client_version }),
        );
        // Solo aprobar: ni `operator`, ni `host`. Observar ya lo hace la otra conexión.
        params.insert("roles".into(), json!(["approver"]));
        // La clave se consume aquí y la línea se borra al soltarse.
        let hello = secret.into_hello_line(&params);
        let sent = tokio::time::timeout(Duration::from_secs(5), writer.write_all(&hello)).await;
        drop(hello);
        drop(params);
        if !matches!(sent, Ok(Ok(()))) {
            reader_task.abort();
            let _ = reply.send(Err(CommandError::new(
                CommandErrorKind::NotSent,
                "The Stratum daemon closed the connection.",
            )));
            return;
        }
        self.failure = None;
        self.conn = Some(Conn {
            writer,
            lines,
            _reader: AbortOnDrop(reader_task),
            phase: Phase::Handshake {
                reply,
                deadline: Instant::now() + self.cfg.timings.handshake_timeout,
            },
            identity: endpoint.identity(),
            next_id: 2,
            pending: HashMap::new(),
        });
    }

    async fn resolve(&mut self, action: ApproverAction, reply: Reply) -> Step {
        let Some(conn) = self.conn.as_mut() else {
            let _ = reply.send(Err(locked()));
            return Step::Nothing;
        };
        match conn.phase {
            Phase::Ready { until, expires_at } if expired(until, expires_at) => {
                let _ = reply.send(Err(locked()));
                return Step::Close(LockReason::Expired);
            }
            Phase::Ready { .. } => {}
            Phase::Handshake { .. } => {
                let _ = reply.send(Err(locked()));
                return Step::Nothing;
            }
        }
        // Un desbloqueo es de un arranque concreto del daemon: si ya hay otro, no vale.
        let current = match discovery::locate(&self.cfg.endpoint_dir) {
            Discovery::Found(endpoint) => Some(endpoint.identity()),
            _ => None,
        };
        if current.as_ref() != Some(&conn.identity) {
            let _ = reply.send(Err(locked()));
            return Step::Close(LockReason::DaemonChanged);
        }
        self.operations += 1;
        let operation_id = format!("{}-{}", self.operation_prefix, self.operations);
        let (method, params) = match resolve_request(&action, &operation_id) {
            Ok(request) => request,
            Err(error) => {
                let _ = reply.send(Err(error));
                return Step::Nothing;
            }
        };
        // Qué y sobre qué solicitud; nunca la frase ni las respuestas.
        self.cfg.logger.info(&format!(
            "approver: resolve {} request={}",
            action.name(),
            action.request_id()
        ));
        let id = conn.next_id;
        conn.next_id += 1;
        let line = wire::request_line(id, method, params);
        if line.len() > MAX_MESSAGE_BYTES {
            let _ = reply.send(Err(invalid("The answer is too large.")));
            return Step::Nothing;
        }
        let deadline = Instant::now() + self.cfg.timings.request_timeout;
        conn.pending.insert(id, (reply, deadline));
        let written = tokio::time::timeout(
            Duration::from_secs(5),
            conn.writer.write_all(line.as_bytes()),
        )
        .await;
        if matches!(written, Ok(Ok(()))) {
            Step::Nothing
        } else {
            // Puede haber salido entera o en parte: desconocido, y la conexión ya no vale.
            Step::Close(LockReason::ConnectionLost)
        }
    }

    async fn on_line(&mut self, line: &str) -> Step {
        let Some(conn) = self.conn.as_mut() else {
            return Step::Nothing;
        };
        match wire::classify(line) {
            Incoming::Ignored | Incoming::Notification { .. } => Step::Nothing,
            Incoming::Request { id } => {
                let reply = wire::method_not_found_line(&id);
                if conn.writer.write_all(reply.as_bytes()).await.is_err() {
                    return Step::Close(LockReason::ConnectionLost);
                }
                Step::Nothing
            }
            Incoming::ConnectionError(error) => {
                self.cfg.logger.warn(&format!(
                    "approver: daemon reported a connection error ({})",
                    error.code
                ));
                Step::Nothing
            }
            Incoming::Response { id: 1, outcome } => {
                let Phase::Handshake { .. } = conn.phase else {
                    return Step::Nothing;
                };
                self.on_hello(outcome)
            }
            Incoming::Response { id, outcome } => {
                if let Some((reply, _)) = conn.pending.remove(&id) {
                    let _ = reply.send(outcome.map(|_| ()).map_err(|error| CommandError {
                        kind: CommandErrorKind::Rejected,
                        code: Some(error.code),
                        reason: error.reason,
                        message: error.message,
                    }));
                }
                Step::Nothing
            }
        }
    }

    fn on_hello(&mut self, outcome: Result<Value, WireError>) -> Step {
        let granted = match &outcome {
            Ok(result) => {
                let protocol = result.get("protocol").and_then(Value::as_u64);
                // No se asume: hace falta que el daemon haya concedido `approve`.
                let approve = result
                    .get("capabilities")
                    .and_then(Value::as_array)
                    .is_some_and(|caps| caps.iter().any(|c| c.as_str() == Some("approve")));
                protocol == Some(PROTOCOL_VERSION) && approve
            }
            Err(_) => false,
        };
        let Some(conn) = self.conn.as_mut() else {
            return Step::Nothing;
        };
        if !granted {
            let code = match &outcome {
                Err(error) => error.code.clone(),
                Ok(_) => "NOT_GRANTED".into(),
            };
            self.cfg
                .logger
                .warn(&format!("approver: unlock failed ({code})"));
            // `close` contesta al que esperaba y arranca la espera antes de otro intento.
            return Step::Close(LockReason::Initial);
        }
        let until = Instant::now() + self.cfg.timings.unlocked_for;
        let expires_at = now_ms() + self.cfg.timings.unlocked_for.as_millis() as u64;
        let phase = std::mem::replace(&mut conn.phase, Phase::Ready { until, expires_at });
        if let Phase::Handshake { reply, .. } = phase {
            let _ = reply.send(Ok(()));
        }
        self.failure = None;
        self.cooldown_until = None;
        let connection_id = outcome
            .ok()
            .and_then(|r| r.get("connectionId").and_then(Value::as_u64))
            .map(|n| n.to_string())
            .unwrap_or_else(|| "?".into());
        self.cfg.logger.info(&format!(
            "approver: unlocked (connection {connection_id}, for {}s)",
            self.cfg.timings.unlocked_for.as_secs()
        ));
        Step::Nothing
    }
}

struct AbortOnDrop(tokio::task::JoinHandle<()>);

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cada_decision_va_a_su_metodo_y_siempre_con_la_sesion() {
        let (method, params) = resolve_request(
            &ApproverAction::Approve {
                session_id: "ses_a".into(),
                approval_id: "apr_1".into(),
                phrase: Some("prod".into()),
                for_session: false,
            },
            "op-1",
        )
        .unwrap();
        assert_eq!(method, ApproverMethod::ApprovalsResolve);
        assert_eq!(
            params,
            json!({ "sessionId": "ses_a", "approvalId": "apr_1", "decision": "approve", "phrase": "prod", "operationId": "op-1" })
        );

        let (_, params) = resolve_request(
            &ApproverAction::Approve {
                session_id: "ses_a".into(),
                approval_id: "apr_1".into(),
                phrase: None,
                for_session: true,
            },
            "op-2",
        )
        .unwrap();
        assert_eq!(params["decision"], "allow-all");

        let (method, params) = resolve_request(
            &ApproverAction::Deny {
                session_id: "ses_a".into(),
                approval_id: "apr_1".into(),
            },
            "op-3",
        )
        .unwrap();
        assert_eq!(
            (method, params["decision"].clone()),
            (ApproverMethod::ApprovalsResolve, json!("deny"))
        );

        let (method, params) = resolve_request(
            &ApproverAction::AnswerQuestions {
                session_id: "ses_b".into(),
                request_id: "q_1".into(),
                answers: Some(vec![QuestionAnswer {
                    question: "¿Cuál?".into(),
                    answer: "A".into(),
                    option_id: Some("o1".into()),
                }]),
            },
            "op-4",
        )
        .unwrap();
        assert_eq!(method, ApproverMethod::QuestionsAnswer);
        assert_eq!(
            params,
            json!({ "sessionId": "ses_b", "requestId": "q_1", "answers": [{ "question": "¿Cuál?", "answer": "A", "optionId": "o1" }], "operationId": "op-4" })
        );
        let (_, params) = resolve_request(
            &ApproverAction::AnswerQuestions {
                session_id: "ses_b".into(),
                request_id: "q_1".into(),
                answers: None,
            },
            "op-5",
        )
        .unwrap();
        assert_eq!(params["answers"], Value::Null);

        let (method, params) = resolve_request(
            &ApproverAction::DecidePlan {
                session_id: "ses_c".into(),
                request_id: "p_1".into(),
                approve: false,
            },
            "op-6",
        )
        .unwrap();
        assert_eq!(method, ApproverMethod::PlansDecide);
        // Sin edición del plan: nunca viaja un `plan`.
        assert_eq!(
            params,
            json!({ "sessionId": "ses_c", "requestId": "p_1", "decision": "reject", "operationId": "op-6" })
        );
    }

    #[test]
    fn lo_que_no_cabe_no_se_envia() {
        let bad = [
            ApproverAction::Deny {
                session_id: String::new(),
                approval_id: "a".into(),
            },
            ApproverAction::Deny {
                session_id: "s".into(),
                approval_id: "x".repeat(MAX_ID_CHARS + 1),
            },
            ApproverAction::Approve {
                session_id: "s".into(),
                approval_id: "a".into(),
                phrase: Some("x".repeat(MAX_PHRASE_CHARS + 1)),
                for_session: false,
            },
            ApproverAction::AnswerQuestions {
                session_id: "s".into(),
                request_id: "q".into(),
                answers: Some(vec![
                    QuestionAnswer {
                        question: "q".into(),
                        answer: "a".into(),
                        option_id: None
                    };
                    MAX_ANSWERS + 1
                ]),
            },
            ApproverAction::AnswerQuestions {
                session_id: "s".into(),
                request_id: "q".into(),
                answers: Some(vec![QuestionAnswer {
                    question: "q".into(),
                    answer: "x".repeat(MAX_ANSWER_CHARS + 1),
                    option_id: None,
                }]),
            },
        ];
        for action in bad {
            assert_eq!(
                resolve_request(&action, "op").unwrap_err().kind,
                CommandErrorKind::Invalid,
                "{}",
                action.name()
            );
        }
    }

    #[test]
    fn el_plazo_vence_con_cualquiera_de_los_dos_relojes() {
        let later = Instant::now() + Duration::from_secs(600);
        // El monotónico no ha llegado, pero el de pared sí (el equipo estuvo suspendido).
        assert!(expired(later, now_ms().saturating_sub(1)));
        assert!(expired(Instant::now(), now_ms() + 600_000));
        assert!(!expired(later, now_ms() + 600_000));
    }

    #[test]
    fn el_estado_se_serializa_sin_datos() {
        assert_eq!(
            serde_json::to_value(ApproverStatus::Locked {
                reason: LockReason::ConnectionLost
            })
            .unwrap(),
            json!({ "kind": "locked", "reason": "connection-lost" })
        );
        assert_eq!(
            serde_json::to_value(ApproverStatus::Ready { expires_at: 5 }).unwrap(),
            json!({ "kind": "ready", "expiresAt": 5 })
        );
        assert_eq!(
            serde_json::to_value(ApproverStatus::Unavailable {
                reason: Unavailable::NoApproverKey
            })
            .unwrap(),
            json!({ "kind": "unavailable", "reason": "no-approver-key" })
        );
    }
}
