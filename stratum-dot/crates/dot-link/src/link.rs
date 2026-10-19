//! El enlace con el daemon: un actor que descubre, conecta, hace el handshake,
//! mantiene las suscripciones y reconecta. Es **el** ciclo de vida de la
//! conexión de Dot; la interfaz solo ve su [`ConnectionState`] y sus [`DotEvent`].
//!
//! ```text
//! starting ──► connecting ──► connected ──► reconnecting ──► connected
//!    │             ▲                              (el daemon volvió)
//!    ▼             │
//! daemon-starting ─┘        incompatible · error  (se sale con `retry`, o
//!                                                  solo si aparece otro daemon)
//! ```
//!
//! Reglas que no se rompen:
//!
//!  - **Dot es un cliente.** Pide el rol `operator` (`observe` + `control`) y
//!    nunca `approver`. Los métodos que puede enviar son los de [`MainMethod`]; la autoridad de
//!    aprobar va por otra conexión ([`crate::approver`]).
//!  - **Cerrar Dot no toca nada.** Al terminar solo se cierra el socket: no hay
//!    `core.shutdown`, ni cancelaciones, ni cierre de sesiones.
//!  - **La foto es la autoridad.** Toda suscripción de sesión se abre pidiendo
//!    foto, también al reconectar; un hueco de `seq` pide otra.
//!  - **Reconectar no es reintentar.** Una orden enviada y sin respuesta queda
//!    con resultado desconocido; no se reenvía.
//!  - **El daemon se arranca una vez por intento explícito** (al abrir Dot o al
//!    pulsar reintentar), nunca al reconectar: si alguien lo paró, no se le
//!    lleva la contraria.
//!  - **Antes del token, quién escucha.** El sistema dice qué proceso atiende el
//!    canal ([`crate::peer`]); si no es el que publicó el endpoint (u otro
//!    usuario), no se envía nada.
//!  - **Colas acotadas.** Las órdenes con respuesta van por una cola de
//!    [`MAX_QUEUED_COMMANDS`] y, llena, se rechazan (`not-sent`) en vez de
//!    crecer; las que no pueden perderse (cerrar, reintentar, `attach`, foco)
//!    no ocupan cola: se anotan y se coalescen.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::collections::VecDeque;
use std::future::Future;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt, WriteHalf};
use tokio::sync::{mpsc, oneshot, Notify};
use tokio::time::Instant;

use crate::discovery::{self, Discovery, Endpoint};
use crate::framing::LineDecoder;
use crate::launcher::DaemonLauncher;
use crate::log::Logger;
use crate::peer::{self, PeerCheck};
use crate::state::{
    CallAction, CommandError, CommandErrorKind, ConnectionState, ControlAction, DotEvent,
};
use crate::subscriptions::{Membership, OverviewSub, SessionSub};
use crate::transport::{self, Stream};
use crate::wire::{self, Incoming, MainMethod, WireError};
use crate::{
    MAX_ID_CHARS, MAX_INPUT_CHARS, MAX_MESSAGE_BYTES, MAX_NAME_CHARS, MAX_PATH_CHARS,
    PROTOCOL_VERSION,
};

/// Sesiones que Dot sigue a la vez. Por encima, las más recientes de la foto
/// de conjunto se quedan sin seguir (y se registra).
pub const MAX_FOLLOWED_SESSIONS: usize = 64;

/// De las sesiones que no se siguen, cuántas se recuerdan (para contarlas y
/// seguirlas cuando quede hueco). Por encima, la cuenta se queda corta.
pub const MAX_UNFOLLOWED_TRACKED: usize = 4_096;

/// Órdenes con respuesta esperando al actor. Llena, la siguiente no se encola.
pub const MAX_QUEUED_COMMANDS: usize = 64;

/// Órdenes y llamadas enviadas al daemon y aún sin respuesta, a la vez.
pub const MAX_IN_FLIGHT: usize = 32;

/// Mensajes por página de `sessions.history` (`HISTORY_LIMITS.messages`).
pub const MAX_HISTORY_PAGE: u32 = 100;

#[derive(Debug, Clone)]
pub struct Timings {
    pub backoff_initial: Duration,
    pub backoff_max: Duration,
    pub request_timeout: Duration,
    /// Abrir una sesión arranca sus servers MCP: puede tardar mucho más que una orden.
    pub open_timeout: Duration,
    pub handshake_timeout: Duration,
    /// Cuánto se espera a que el daemon recién arrancado atienda.
    pub daemon_start_wait: Duration,
    /// Cada cuánto se relee el endpoint sin conexión (`error`, `incompatible`).
    pub idle_poll: Duration,
    pub connect_wait: Duration,
}

impl Default for Timings {
    fn default() -> Self {
        Self {
            backoff_initial: Duration::from_millis(250),
            backoff_max: Duration::from_secs(5),
            request_timeout: Duration::from_secs(10),
            open_timeout: Duration::from_secs(90),
            handshake_timeout: Duration::from_secs(5),
            daemon_start_wait: Duration::from_secs(10),
            idle_poll: Duration::from_secs(2),
            connect_wait: Duration::from_secs(2),
        }
    }
}

/// Qué sesiones sigue el enlace con una suscripción propia (con su foto).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FollowPolicy {
    /// Todas las vivas (hasta [`MAX_FOLLOWED_SESSIONS`]): Dot pinta su
    /// actividad en la lista.
    All,
    /// Solo la enfocada (M12, Desktop): la lista sale de la foto de conjunto,
    /// que ya trae el estado operativo de cada sesión, y la conversación
    /// solo se pide de la que se está mirando.
    Focused,
}

/// Quién es este cliente para el daemon y qué puede pedirle. Es un perfil
/// cerrado: solo existen [`ClientProfile::DOT`] y [`ClientProfile::DESKTOP`].
/// No da autoridad: lo que se puede hacer lo decide el daemon por las
/// capacidades que concede; el perfil solo **resta** (lo que no está en
/// `methods` no sale de aquí aunque el daemon lo permitiera).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ClientProfile {
    kind: &'static str,
    name: &'static str,
    follow: FollowPolicy,
    forward_overview: bool,
    methods: &'static [MainMethod],
}

const DOT_METHODS: &[MainMethod] = &[
    MainMethod::CoreHello,
    MainMethod::EventsSubscribe,
    MainMethod::EventsUnsubscribe,
    MainMethod::RunsPause,
    MainMethod::RunsResume,
    MainMethod::RunsCancel,
    MainMethod::RunsSteer,
    MainMethod::RunsStart,
    MainMethod::SessionsOpen,
    MainMethod::AgentsList,
    MainMethod::ModelsList,
    MainMethod::ApprovalsList,
    MainMethod::SessionsGet,
];

const DESKTOP_METHODS: &[MainMethod] = &[
    MainMethod::CoreHello,
    MainMethod::EventsSubscribe,
    MainMethod::EventsUnsubscribe,
    MainMethod::RunsPause,
    MainMethod::RunsResume,
    MainMethod::RunsCancel,
    MainMethod::RunsSteer,
    MainMethod::RunsStart,
    MainMethod::SessionsOpen,
    MainMethod::AgentsList,
    MainMethod::ModelsList,
    MainMethod::ApprovalsList,
    MainMethod::SessionsGet,
    MainMethod::SessionsHistory,
    MainMethod::SessionsContext,
    MainMethod::SessionsMemory,
    MainMethod::SessionsClose,
    MainMethod::SessionsSetModel,
];

impl ClientProfile {
    /// Stratum Dot: sigue todas las sesiones; de una sesión, abrirla e iniciar
    /// sus runs, pero no cerrarla ni reconfigurarla.
    pub const DOT: ClientProfile = ClientProfile {
        kind: "dot",
        name: "stratum-dot",
        follow: FollowPolicy::All,
        forward_overview: false,
        methods: DOT_METHODS,
    };

    /// Stratum Desktop (M12): lista por la foto de conjunto, conversación solo
    /// de la sesión abierta, y lo de M11 (historial, contexto, memoria),
    /// cerrar y cambiar el modelo.
    pub const DESKTOP: ClientProfile = ClientProfile {
        kind: "desktop",
        name: "stratum-desktop",
        follow: FollowPolicy::Focused,
        forward_overview: true,
        methods: DESKTOP_METHODS,
    };

    pub fn kind(&self) -> &'static str {
        self.kind
    }

    pub fn name(&self) -> &'static str {
        self.name
    }

    pub fn follow(&self) -> FollowPolicy {
        self.follow
    }

    pub fn forward_overview(&self) -> bool {
        self.forward_overview
    }

    pub fn methods(&self) -> &'static [MainMethod] {
        self.methods
    }

    pub fn allows(&self, method: MainMethod) -> bool {
        self.methods.contains(&method)
    }
}

pub struct LinkConfig {
    /// Carpeta de `endpoint.json` (`~/.stratum/daemon/`).
    pub endpoint_dir: PathBuf,
    /// Qué cliente es (M12): Dot o Desktop.
    pub profile: ClientProfile,
    /// Versión del cliente, para `core.hello`.
    pub client_version: String,
    /// Arrancar el daemon si no hay ninguno al abrir Dot (o al reintentar).
    pub autostart: bool,
    pub launcher: Arc<dyn DaemonLauncher>,
    pub logger: Logger,
    pub timings: Timings,
}

type ControlReply = oneshot::Sender<Result<String, CommandError>>;
type CallReply = oneshot::Sender<Result<Value, CommandError>>;

enum Cmd {
    Attach,
    Retry,
    Focus(Option<String>),
    Resync(String),
    Control(ControlAction, ControlReply),
    Call(CallAction, CallReply),
    Shutdown,
}

/// Lo que no puede perderse aunque la cola esté llena. Se coalesce: pedir dos
/// veces lo mismo antes de que el actor lo vea es pedirlo una.
#[derive(Default)]
struct Flags {
    shutdown: bool,
    retry: bool,
    attach: bool,
    /// `Some(foco)`: el último foco pedido.
    focus: Option<Option<String>>,
}

struct Shared {
    state: Mutex<ConnectionState>,
    sessions: AtomicUsize,
    flags: Mutex<Flags>,
    wake: Notify,
}

impl Shared {
    fn flag(&self, set: impl FnOnce(&mut Flags)) {
        if let Ok(mut flags) = self.flags.lock() {
            set(&mut flags);
        }
        self.wake.notify_one();
    }

    fn take_flag(&self) -> Option<Cmd> {
        let mut flags = self.flags.lock().ok()?;
        if std::mem::take(&mut flags.shutdown) {
            return Some(Cmd::Shutdown);
        }
        if std::mem::take(&mut flags.retry) {
            return Some(Cmd::Retry);
        }
        if std::mem::take(&mut flags.attach) {
            return Some(Cmd::Attach);
        }
        flags.focus.take().map(Cmd::Focus)
    }
}

/// Lo que la app tiene del enlace. Barato de clonar.
#[derive(Clone)]
pub struct LinkHandle {
    tx: mpsc::Sender<Cmd>,
    shared: Arc<Shared>,
}

fn gone() -> CommandError {
    CommandError::new(CommandErrorKind::NotSent, "Stratum Dot is shutting down.")
}

fn busy() -> CommandError {
    CommandError::new(
        CommandErrorKind::NotSent,
        "Too many requests at once. Nothing was sent: try again in a moment.",
    )
}

/// Encola una orden con respuesta, o dice por qué no (sin esperar a que haya sitio).
fn enqueue(tx: &mpsc::Sender<Cmd>, cmd: Cmd) -> Result<(), CommandError> {
    tx.try_send(cmd).map_err(|e| match e {
        mpsc::error::TrySendError::Full(_) => busy(),
        mpsc::error::TrySendError::Closed(_) => gone(),
    })
}

impl LinkHandle {
    pub fn connection(&self) -> ConnectionState {
        self.shared
            .state
            .lock()
            .map(|s| s.clone())
            .unwrap_or(ConnectionState::Starting)
    }

    /// Sesiones vivas que se están siguiendo.
    pub fn session_count(&self) -> usize {
        self.shared.sessions.load(Ordering::Relaxed)
    }

    /// La interfaz acaba de cargar (o de recargar): se le repite el estado de
    /// la conexión y todas las suscripciones se reabren, así que recibe una
    /// foto de cada sesión. Aquí no se guarda ninguna foto para reenviarla.
    pub fn attach(&self) {
        self.shared.flag(|f| f.attach = true);
    }

    /// Vuelve a empezar: descubrir, arrancar el daemon si hace falta, conectar.
    pub fn retry(&self) {
        self.shared.flag(|f| f.retry = true);
    }

    /// Qué sesión se está mirando: es la única que recibe el texto según se genera.
    pub fn focus(&self, session_id: Option<String>) {
        self.shared.flag(|f| f.focus = Some(session_id));
    }

    /// Pide una foto nueva de una sesión (la interfaz no pudo aplicar un evento).
    /// Con la cola llena se descarta: es idempotente, y la foto llegará con la
    /// siguiente petición o el siguiente hueco de `seq`.
    pub fn resync_session(&self, session_id: String) {
        let _ = self.tx.try_send(Cmd::Resync(session_id));
    }

    /// Da una orden y devuelve el `status` que contesta el anfitrión de la
    /// sesión (`requested`, `resumed`, `cancelled`, `accepted`…). Que la orden
    /// se acepte **no** cambia el estado que ve la interfaz: eso llega por
    /// eventos, cuando el runtime lo alcanza.
    pub async fn control(&self, action: ControlAction) -> Result<String, CommandError> {
        let (reply, answer) = oneshot::channel();
        enqueue(&self.tx, Cmd::Control(action, reply))?;
        answer.await.unwrap_or_else(|_| Err(gone()))
    }

    /// Hace una llamada y devuelve su `result` **sin interpretar** (un DTO del
    /// protocolo, que valida quien lo recibe). Abrir una sesión o iniciar un run
    /// no cambian nada de lo que ve la interfaz: la sesión y el run aparecen por
    /// eventos, cuando su anfitrión los publica.
    pub async fn call(&self, action: CallAction) -> Result<Value, CommandError> {
        let (reply, answer) = oneshot::channel();
        enqueue(&self.tx, Cmd::Call(action, reply))?;
        answer.await.unwrap_or_else(|_| Err(gone()))
    }

    /// Dot se cierra: se suelta la conexión. El daemon y sus sesiones siguen.
    pub fn shutdown(&self) {
        self.shared.flag(|f| f.shutdown = true);
    }
}

/// Crea el enlace. Devuelve el mango y la tarea, que quien llama lanza en su
/// runtime de tokio. `sink` recibe cada [`DotEvent`], en orden.
pub fn spawn(
    config: LinkConfig,
    sink: impl Fn(DotEvent) + Send + Sync + 'static,
) -> (LinkHandle, impl Future<Output = ()> + Send + 'static) {
    let (tx, rx) = mpsc::channel(MAX_QUEUED_COMMANDS);
    let shared = Arc::new(Shared {
        state: Mutex::new(ConnectionState::Starting),
        sessions: AtomicUsize::new(0),
        flags: Mutex::new(Flags::default()),
        wake: Notify::new(),
    });
    let actor = Actor {
        autostart_armed: config.autostart,
        cfg: config,
        rx,
        sink: Box::new(sink),
        shared: shared.clone(),
        focus: None,
        rejected: None,
        operations: 0,
        operation_prefix: format!(
            "dot-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ),
    };
    (LinkHandle { tx, shared }, actor.run())
}

/// Por qué terminó una espera.
enum Wake {
    Timeout,
    Retry,
    Shutdown,
}

/// Cómo terminó una conexión.
enum End {
    Shutdown,
    /// Hubo conexión lista y se perdió.
    Lost,
    /// No se llegó a conectar, o el handshake no terminó: se puede reintentar.
    Unreachable(String),
    Mismatch {
        daemon_protocol: Option<u64>,
    },
    /// El daemon no admite a este cliente: reintentar contra el mismo no sirve.
    Fatal(String),
}

enum Next {
    Backoff,
    Unavailable(String),
    Poll,
}

enum Pending {
    SubOverview { generation: u32 },
    SubSession { session_id: String, generation: u32 },
    Unsub,
    Control { reply: ControlReply },
    Call { reply: CallReply, mutating: bool },
}

/// Lo que se contesta a una llamada que salió y se quedó sin respuesta.
fn unanswered(mutating: bool, why: &str) -> CommandError {
    if mutating {
        CommandError::new(
            CommandErrorKind::Unknown,
            format!("{why} The result is unknown: check the session before trying again."),
        )
    } else {
        CommandError::new(CommandErrorKind::NoAnswer, why)
    }
}

enum Route {
    Overview,
    Session(String),
}

/// Una conexión viva y todo lo que solo vale mientras dura.
struct Conn {
    writer: WriteHalf<Stream>,
    next_id: u64,
    pending: HashMap<u64, (Pending, Instant)>,
    overview: OverviewSub,
    overview_generation: u32,
    sessions: HashMap<String, SessionSub>,
    /// Orden de la foto de conjunto; las nuevas, al final.
    order: Vec<String>,
    /// Sesiones vivas que no caben en [`MAX_FOLLOWED_SESSIONS`], por orden de
    /// llegada: se cuentan y se siguen cuando queda hueco.
    unfollowed: VecDeque<String>,
    /// Con [`FollowPolicy::Focused`]: todas las sesiones vivas según la foto de
    /// conjunto (en `order` solo está la seguida).
    live: Vec<String>,
    routes: HashMap<String, Route>,
    can_control: bool,
    request_timeout: Duration,
}

impl Conn {
    async fn send(&mut self, line: String) -> std::io::Result<()> {
        if line.len() > MAX_MESSAGE_BYTES {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "frame too large",
            ));
        }
        match tokio::time::timeout(
            Duration::from_secs(5),
            self.writer.write_all(line.as_bytes()),
        )
        .await
        {
            Ok(result) => result,
            Err(_) => Err(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                "write timed out",
            )),
        }
    }

    async fn request(
        &mut self,
        method: MainMethod,
        params: Value,
        pending: Pending,
    ) -> std::io::Result<()> {
        let timeout = self.request_timeout;
        self.request_within(method, params, pending, timeout).await
    }

    /// Órdenes y llamadas de la interfaz que esperan respuesta.
    fn in_flight(&self) -> usize {
        self.pending
            .values()
            .filter(|(p, _)| matches!(p, Pending::Control { .. } | Pending::Call { .. }))
            .count()
    }

    async fn request_within(
        &mut self,
        method: MainMethod,
        params: Value,
        pending: Pending,
        timeout: Duration,
    ) -> std::io::Result<()> {
        let id = self.next_id;
        self.next_id += 1;
        self.pending.insert(id, (pending, Instant::now() + timeout));
        self.send(wire::request_line(id, method, params)).await
    }

    async fn unsubscribe(&mut self, server_id: String) -> std::io::Result<()> {
        self.routes.remove(&server_id);
        self.request(
            MainMethod::EventsUnsubscribe,
            json!({ "subscriptionId": server_id }),
            Pending::Unsub,
        )
        .await
    }

    async fn open_overview(&mut self) -> std::io::Result<()> {
        self.overview_generation = self.overview_generation.wrapping_add(1);
        let generation = self.overview_generation;
        self.request(
            MainMethod::EventsSubscribe,
            json!({ "scope": { "kind": "overview" } }),
            Pending::SubOverview { generation },
        )
        .await
    }

    /// Abre la suscripción de una sesión seguida. Siempre pide foto (sin `sinceSeq`).
    async fn open_session(&mut self, session_id: &str) -> std::io::Result<()> {
        let Some(sub) = self.sessions.get(session_id) else {
            return Ok(());
        };
        let pending = Pending::SubSession {
            session_id: session_id.to_string(),
            generation: sub.generation,
        };
        let params = json!({ "scope": { "kind": "session", "sessionId": session_id, "volatile": sub.volatile } });
        self.request(MainMethod::EventsSubscribe, params, pending)
            .await
    }

    async fn reopen_session(&mut self, session_id: &str, volatile: bool) -> std::io::Result<()> {
        let Some(sub) = self.sessions.get_mut(session_id) else {
            return Ok(());
        };
        if let Some(stale) = sub.reopen(volatile) {
            self.unsubscribe(stale).await?;
        }
        self.open_session(session_id).await
    }

    /// Toda orden sin respuesta queda con resultado desconocido. No se reenvía.
    fn fail_pending(&mut self) {
        for (_, (pending, _)) in self.pending.drain() {
            match pending {
                Pending::Control { reply } => {
                    let _ = reply.send(Err(CommandError::new(
                        CommandErrorKind::Unknown,
                        "The connection was lost before the daemon answered. Check the run state before trying again.",
                    )));
                }
                Pending::Call { reply, mutating } => {
                    let _ = reply.send(Err(unanswered(
                        mutating,
                        "The connection was lost before the daemon answered.",
                    )));
                }
                _ => {}
            }
        }
    }
}

struct Actor {
    cfg: LinkConfig,
    rx: mpsc::Receiver<Cmd>,
    sink: Box<dyn Fn(DotEvent) + Send + Sync>,
    shared: Arc<Shared>,
    focus: Option<String>,
    autostart_armed: bool,
    /// El daemon (pid + arranque) que rechazó a este cliente: no se le insiste.
    rejected: Option<(u32, String)>,
    /// Para dar a cada petición que cambia algo un `operationId` propio.
    operations: u64,
    operation_prefix: String,
}

fn not_connected() -> CommandError {
    CommandError::new(
        CommandErrorKind::NotSent,
        "Not connected to the Stratum daemon.",
    )
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.chars().count() <= MAX_ID_CHARS
}

/// Método y parámetros de una orden, o por qué no vale.
fn control_request(action: &ControlAction) -> Result<(MainMethod, Value), CommandError> {
    let invalid = |message: &str| CommandError::new(CommandErrorKind::Invalid, message);
    let run_scoped = |session_id: &str, run_id: &Option<String>| -> Result<Value, CommandError> {
        if !valid_id(session_id) {
            return Err(invalid("Invalid session id."));
        }
        match run_id {
            Some(run) if !valid_id(run) => Err(invalid("Invalid run id.")),
            Some(run) => Ok(json!({ "sessionId": session_id, "runId": run })),
            None => Ok(json!({ "sessionId": session_id })),
        }
    };
    match action {
        ControlAction::Pause { session_id, run_id } => {
            Ok((MainMethod::RunsPause, run_scoped(session_id, run_id)?))
        }
        ControlAction::Resume { session_id, run_id } => {
            Ok((MainMethod::RunsResume, run_scoped(session_id, run_id)?))
        }
        ControlAction::Cancel { session_id, run_id } => {
            Ok((MainMethod::RunsCancel, run_scoped(session_id, run_id)?))
        }
        ControlAction::Steer { session_id, text } => {
            if !valid_id(session_id) {
                return Err(invalid("Invalid session id."));
            }
            // Nunca se recorta: o cabe entero o no se envía.
            if text.chars().count() > MAX_INPUT_CHARS {
                return Err(invalid("The message is too long."));
            }
            Ok((
                MainMethod::RunsSteer,
                json!({ "sessionId": session_id, "text": text }),
            ))
        }
    }
}

/// Un campo opcional de texto: vacío es «no pedido».
fn optional(
    value: &Option<String>,
    max: usize,
    what: &str,
) -> Result<Option<String>, CommandError> {
    let Some(text) = value.as_deref().map(str::trim).filter(|t| !t.is_empty()) else {
        return Ok(None);
    };
    if text.chars().count() > max {
        return Err(CommandError::new(
            CommandErrorKind::Invalid,
            format!("The {what} is too long."),
        ));
    }
    Ok(Some(text.to_string()))
}

/// Método y parámetros de una llamada, o por qué no vale. Solo se comprueba
/// que quepa en el protocolo: si un directorio existe o un perfil vale lo dice
/// el daemon, que es quien manda.
fn call_request(
    action: &CallAction,
    operation_id: &str,
) -> Result<(MainMethod, Value), CommandError> {
    let invalid = |message: &str| CommandError::new(CommandErrorKind::Invalid, message);
    match action {
        CallAction::OpenSession {
            cwd,
            agent,
            provider,
            model,
        } => {
            let mut params = serde_json::Map::new();
            let fields = [
                ("cwd", optional(cwd, MAX_PATH_CHARS, "directory")?),
                ("agent", optional(agent, MAX_NAME_CHARS, "agent name")?),
                (
                    "provider",
                    optional(provider, MAX_NAME_CHARS, "provider name")?,
                ),
                ("model", optional(model, MAX_NAME_CHARS, "model name")?),
            ];
            for (key, value) in fields {
                if let Some(value) = value {
                    params.insert(key.to_string(), Value::String(value));
                }
            }
            params.insert("operationId".into(), Value::String(operation_id.into()));
            Ok((MainMethod::SessionsOpen, Value::Object(params)))
        }
        CallAction::StartRun { session_id, input } => {
            if !valid_id(session_id) {
                return Err(invalid("Invalid session id."));
            }
            if input.trim().is_empty() {
                return Err(invalid("Nothing to send."));
            }
            // Nunca se recorta: o cabe entero o no se envía.
            if input.chars().count() > MAX_INPUT_CHARS {
                return Err(invalid("The message is too long."));
            }
            Ok((
                MainMethod::RunsStart,
                json!({ "sessionId": session_id, "input": input, "operationId": operation_id }),
            ))
        }
        CallAction::ListAgents { cwd } => Ok((
            MainMethod::AgentsList,
            match optional(cwd, MAX_PATH_CHARS, "directory")? {
                Some(cwd) => json!({ "cwd": cwd }),
                None => json!({}),
            },
        )),
        CallAction::ListModels => Ok((MainMethod::ModelsList, json!({}))),
        CallAction::ListPending { session_id } => {
            if !valid_id(session_id) {
                return Err(invalid("Invalid session id."));
            }
            Ok((
                MainMethod::ApprovalsList,
                json!({ "sessionId": session_id }),
            ))
        }
        CallAction::GetSession { session_id } => {
            if !valid_id(session_id) {
                return Err(invalid("Invalid session id."));
            }
            Ok((MainMethod::SessionsGet, json!({ "sessionId": session_id })))
        }
        CallAction::History {
            session_id,
            before,
            limit,
        } => {
            if !valid_id(session_id) {
                return Err(invalid("Invalid session id."));
            }
            let mut params = serde_json::Map::new();
            params.insert("sessionId".into(), Value::String(session_id.clone()));
            if let Some(before) = before {
                if !valid_id(before) {
                    return Err(invalid("Invalid message id."));
                }
                params.insert("before".into(), Value::String(before.clone()));
            }
            if let Some(limit) = limit {
                if *limit == 0 || *limit > MAX_HISTORY_PAGE {
                    return Err(invalid("Invalid page size."));
                }
                params.insert("limit".into(), json!(limit));
            }
            Ok((MainMethod::SessionsHistory, Value::Object(params)))
        }
        CallAction::Context { session_id } => {
            if !valid_id(session_id) {
                return Err(invalid("Invalid session id."));
            }
            Ok((
                MainMethod::SessionsContext,
                json!({ "sessionId": session_id }),
            ))
        }
        CallAction::Memory { session_id } => {
            if !valid_id(session_id) {
                return Err(invalid("Invalid session id."));
            }
            Ok((
                MainMethod::SessionsMemory,
                json!({ "sessionId": session_id }),
            ))
        }
        CallAction::CloseSession { session_id } => {
            if !valid_id(session_id) {
                return Err(invalid("Invalid session id."));
            }
            Ok((
                MainMethod::SessionsClose,
                json!({ "sessionId": session_id, "operationId": operation_id }),
            ))
        }
        CallAction::SetModel { session_id, model } => {
            if !valid_id(session_id) {
                return Err(invalid("Invalid session id."));
            }
            let Some(model) = optional(&Some(model.clone()), MAX_NAME_CHARS, "model name")? else {
                return Err(invalid("Choose a model."));
            };
            Ok((
                MainMethod::SessionsSetModel,
                json!({ "sessionId": session_id, "model": model, "operationId": operation_id }),
            ))
        }
    }
}

fn strings(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

impl Actor {
    fn emit(&self, event: DotEvent) {
        (self.sink)(event);
    }

    /// Lo que no está en el perfil de este cliente no sale (no se envía nada).
    fn allowed(&self, method: MainMethod) -> Result<(), CommandError> {
        if self.cfg.profile.allows(method) {
            Ok(())
        } else {
            Err(CommandError::new(
                CommandErrorKind::Invalid,
                "This client does not make that request.",
            ))
        }
    }

    /// La siguiente orden: primero lo anotado (cerrar, reintentar, `attach`,
    /// foco), después la cola. Se puede cancelar sin perder nada.
    async fn next_cmd(&mut self) -> Option<Cmd> {
        let shared = self.shared.clone();
        loop {
            if let Some(cmd) = shared.take_flag() {
                return Some(cmd);
            }
            tokio::select! {
                biased;
                _ = shared.wake.notified() => {}
                cmd = self.rx.recv() => return cmd,
            }
        }
    }

    fn state(&self) -> ConnectionState {
        self.shared
            .state
            .lock()
            .map(|s| s.clone())
            .unwrap_or(ConnectionState::Starting)
    }

    fn set_state(&self, next: ConnectionState) {
        {
            let Ok(mut current) = self.shared.state.lock() else {
                return;
            };
            if *current == next {
                return;
            }
            *current = next.clone();
        }
        self.cfg
            .logger
            .info(&format!("connection: {}", next.name()));
        self.emit(DotEvent::Connection { state: next });
    }

    fn backoff(&self, attempt: u32) -> Duration {
        let factor = 2u32.saturating_pow(attempt.saturating_sub(1).min(16));
        self.cfg
            .timings
            .backoff_initial
            .saturating_mul(factor)
            .min(self.cfg.timings.backoff_max)
    }

    /// Lo que se hace con una orden cuando no hay conexión.
    fn offline(&mut self, cmd: Cmd) -> Option<Wake> {
        match cmd {
            Cmd::Shutdown => return Some(Wake::Shutdown),
            Cmd::Retry => return Some(Wake::Retry),
            Cmd::Attach => self.emit(DotEvent::Connection {
                state: self.state(),
            }),
            Cmd::Focus(focus) => self.focus = focus,
            Cmd::Resync(_) => {}
            // No se encola para más tarde: falla en el acto.
            Cmd::Control(_, reply) => {
                let _ = reply.send(Err(not_connected()));
            }
            Cmd::Call(_, reply) => {
                let _ = reply.send(Err(not_connected()));
            }
        }
        None
    }

    /// Espera `duration` atendiendo órdenes.
    async fn idle(&mut self, duration: Duration) -> Wake {
        let sleep = tokio::time::sleep(duration);
        tokio::pin!(sleep);
        loop {
            tokio::select! {
                _ = &mut sleep => return Wake::Timeout,
                cmd = self.next_cmd() => match cmd {
                    None => return Wake::Shutdown,
                    Some(cmd) => if let Some(wake) = self.offline(cmd) { return wake },
                },
            }
        }
    }

    /// Espera a `future` atendiendo órdenes. Un `retry` aquí no hace nada: ya
    /// se está en ello.
    async fn busy<T>(&mut self, future: impl Future<Output = T>) -> Result<T, Wake> {
        tokio::pin!(future);
        loop {
            tokio::select! {
                out = &mut future => return Ok(out),
                cmd = self.next_cmd() => match cmd {
                    None => return Err(Wake::Shutdown),
                    Some(cmd) => {
                        if let Some(Wake::Shutdown) = self.offline(cmd) {
                            return Err(Wake::Shutdown);
                        }
                    }
                },
            }
        }
    }

    async fn run(mut self) {
        self.cfg
            .logger
            .info(&format!("dot link start (protocol v{PROTOCOL_VERSION})"));
        // 0 = no se está reconectando (primer intento, o tras `retry`).
        let mut reconnecting: u32 = 0;
        loop {
            let found = discovery::locate(&self.cfg.endpoint_dir);
            let next = match found {
                Discovery::Found(endpoint) => {
                    if self.rejected.as_ref() == Some(&endpoint.identity()) {
                        Next::Poll
                    } else {
                        self.rejected = None;
                        if reconnecting == 0 {
                            self.set_state(ConnectionState::Connecting);
                        }
                        self.cfg.logger.info(&format!(
                            "discovery: found daemon pid={} version={}",
                            endpoint.pid, endpoint.version
                        ));
                        match self.session(&endpoint).await {
                            End::Shutdown => break,
                            End::Lost => {
                                reconnecting = 1;
                                self.set_state(ConnectionState::Reconnecting { attempt: 1 });
                                Next::Backoff
                            }
                            End::Unreachable(why) => Next::Unavailable(why),
                            End::Mismatch { daemon_protocol } => {
                                reconnecting = 0;
                                self.rejected = Some(endpoint.identity());
                                self.cfg.logger.warn(&format!(
                                    "protocol mismatch: dot v{PROTOCOL_VERSION}, daemon v{}",
                                    daemon_protocol
                                        .map(|p| p.to_string())
                                        .unwrap_or_else(|| "?".into())
                                ));
                                self.set_state(ConnectionState::Incompatible {
                                    client_protocol: PROTOCOL_VERSION,
                                    daemon_protocol,
                                    daemon_version: Some(endpoint.version.clone()),
                                });
                                Next::Poll
                            }
                            End::Fatal(message) => {
                                reconnecting = 0;
                                self.rejected = Some(endpoint.identity());
                                self.cfg
                                    .logger
                                    .error(&format!("connection refused: {message}"));
                                self.set_state(ConnectionState::Error { message });
                                Next::Poll
                            }
                        }
                    }
                }
                Discovery::Absent => Next::Unavailable("The Stratum daemon is not running.".into()),
                Discovery::Stale { pid } => Next::Unavailable(format!(
                    "The Stratum daemon is not running (stale endpoint left by pid {pid})."
                )),
                Discovery::Invalid { reason } => Next::Unavailable(format!(
                    "The Stratum daemon endpoint cannot be read ({reason})."
                )),
                Discovery::Incompatible { protocol, version } => {
                    reconnecting = 0;
                    self.set_state(ConnectionState::Incompatible {
                        client_protocol: PROTOCOL_VERSION,
                        daemon_protocol: Some(protocol),
                        daemon_version: Some(version),
                    });
                    Next::Poll
                }
            };

            let wake = match next {
                Next::Backoff => self.idle(self.backoff(reconnecting)).await,
                Next::Poll => self.idle(self.cfg.timings.idle_poll).await,
                Next::Unavailable(why) => {
                    if reconnecting > 0 {
                        // Hubo conexión: se espera a que el daemon vuelva. No se arranca.
                        reconnecting = reconnecting.saturating_add(1);
                        self.set_state(ConnectionState::Reconnecting {
                            attempt: reconnecting,
                        });
                        self.idle(self.backoff(reconnecting)).await
                    } else if self.autostart_armed {
                        self.autostart_armed = false;
                        match self.start_daemon().await {
                            Ok(()) => Wake::Timeout,
                            Err(Some(message)) => {
                                self.cfg
                                    .logger
                                    .error(&format!("daemon start failed: {message}"));
                                self.set_state(ConnectionState::Error { message });
                                self.idle(self.cfg.timings.idle_poll).await
                            }
                            Err(None) => Wake::Shutdown,
                        }
                    } else {
                        self.set_state(ConnectionState::Error { message: why });
                        self.idle(self.cfg.timings.idle_poll).await
                    }
                }
            };
            match wake {
                Wake::Timeout => {}
                Wake::Shutdown => break,
                Wake::Retry => {
                    self.cfg.logger.info("retry requested");
                    reconnecting = 0;
                    self.autostart_armed = self.cfg.autostart;
                    self.rejected = None;
                    self.set_state(ConnectionState::Starting);
                }
            }
        }
        self.cfg
            .logger
            .info("dot link stop (the daemon keeps running)");
    }

    /// Arranca el daemon con la CLI oficial y espera a que publique un endpoint
    /// válido. `Err(None)`: Dot se cierra mientras tanto.
    async fn start_daemon(&mut self) -> Result<(), Option<String>> {
        self.set_state(ConnectionState::DaemonStarting);
        self.cfg
            .logger
            .info("daemon start: running `stratum daemon start`");
        let launcher = self.cfg.launcher.clone();
        match self.busy(launcher.start()).await {
            Err(_) => return Err(None),
            Ok(Err(message)) => {
                return Err(Some(format!(
                    "Could not start the Stratum daemon: {message}"
                )))
            }
            Ok(Ok(())) => {}
        }
        let deadline = Instant::now() + self.cfg.timings.daemon_start_wait;
        loop {
            match discovery::locate(&self.cfg.endpoint_dir) {
                Discovery::Found(_) | Discovery::Incompatible { .. } => return Ok(()),
                _ if Instant::now() >= deadline => {
                    return Err(Some(
                        "The Stratum daemon was started but did not come up in time.".into(),
                    ));
                }
                _ => {}
            }
            match self.idle(Duration::from_millis(150)).await {
                Wake::Shutdown => return Err(None),
                // Ya se está arrancando: un `retry` aquí no añade nada.
                Wake::Timeout | Wake::Retry => {}
            }
        }
    }

    /// Una conexión, de principio a fin.
    async fn session(&mut self, endpoint: &Endpoint) -> End {
        let stream =
            match transport::connect(&endpoint.ipc_path, self.cfg.timings.connect_wait).await {
                Ok(stream) => stream,
                Err(e) => {
                    self.cfg
                        .logger
                        .warn(&format!("connect failed ({:?})", e.kind()));
                    return End::Unreachable("The Stratum daemon is not answering.".into());
                }
            };
        // Antes de enviar el token: ¿lo atiende el daemon que publicó el endpoint?
        match peer::verify(&stream, endpoint.pid) {
            Ok(PeerCheck::Verified) => {}
            Ok(PeerCheck::Partial { what }) => self.cfg.logger.warn(&format!(
                "peer identity: the OS did not confirm the {what} serving the channel"
            )),
            Err(mismatch) => {
                self.cfg
                    .logger
                    .error(&format!("peer identity: {mismatch}; nothing was sent"));
                return End::Fatal(
                    "The process answering on the daemon's channel is not the daemon that published the endpoint. Nothing was sent.".into(),
                );
            }
        }
        let (mut reader, writer) = tokio::io::split(stream);

        // El lector vive en su tarea: así el bucle de abajo nunca corta una lectura a medias.
        let (line_tx, mut lines) = mpsc::channel::<String>(256);
        let reader_task = tokio::spawn(async move {
            let mut decoder = LineDecoder::new(MAX_MESSAGE_BYTES);
            let mut chunk = vec![0u8; 64 * 1024];
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
        let _reader_guard = AbortOnDrop(reader_task);

        let mut conn = Conn {
            writer,
            next_id: 2,
            pending: HashMap::new(),
            overview: OverviewSub::default(),
            overview_generation: 0,
            sessions: HashMap::new(),
            order: Vec::new(),
            unfollowed: VecDeque::new(),
            live: Vec::new(),
            routes: HashMap::new(),
            can_control: false,
            request_timeout: self.cfg.timings.request_timeout,
        };

        // --- handshake: lo primero y lo único hasta que termina bien ---------
        let hello = wire::request_line(
            1,
            MainMethod::CoreHello,
            json!({
                "protocol": PROTOCOL_VERSION,
                "token": endpoint.token.expose(),
                "client": {
                    "kind": self.cfg.profile.kind(),
                    "name": self.cfg.profile.name(),
                    "version": self.cfg.client_version,
                },
                // Mínima autoridad: observar y conducir runs. Nunca `approver`.
                "roles": ["operator"],
            }),
        );
        if conn.send(hello).await.is_err() {
            return End::Unreachable("The Stratum daemon closed the connection.".into());
        }
        let handshake_timeout = self.cfg.timings.handshake_timeout;
        let answer = self
            .busy(async {
                let deadline = Instant::now() + handshake_timeout;
                loop {
                    match tokio::time::timeout_at(deadline, lines.recv()).await {
                        Err(_) | Ok(None) => return None,
                        Ok(Some(line)) => match wire::classify(&line) {
                            Incoming::Response { id: 1, outcome } => return Some(outcome),
                            Incoming::ConnectionError(error) => return Some(Err(error)),
                            _ => {}
                        },
                    }
                }
            })
            .await;
        let hello = match answer {
            Err(_) => return End::Shutdown,
            Ok(None) => {
                return End::Unreachable(
                    "The Stratum daemon did not complete the handshake.".into(),
                )
            }
            Ok(Some(Err(WireError { code, protocol, .. }))) => {
                return match code.as_str() {
                    "PROTOCOL_MISMATCH" => End::Mismatch {
                        daemon_protocol: protocol,
                    },
                    "UNAUTHORIZED" | "FORBIDDEN" => {
                        End::Fatal(format!("The Stratum daemon rejected this client ({code})."))
                    }
                    _ => End::Unreachable(format!("The handshake failed ({code}).")),
                };
            }
            Ok(Some(Ok(result))) => result,
        };
        // El servidor aceptó, pero dice hablar otra versión: tampoco vale.
        let protocol = hello.get("protocol").and_then(Value::as_u64);
        if protocol != Some(PROTOCOL_VERSION) {
            return End::Mismatch {
                daemon_protocol: protocol,
            };
        }
        let capabilities = strings(hello.get("capabilities"));
        if !capabilities.iter().any(|c| c == "observe") {
            return End::Fatal(
                "The Stratum daemon did not grant this client the right to observe.".into(),
            );
        }
        conn.can_control = capabilities.iter().any(|c| c == "control");
        let server = hello.get("server");
        let text = |key: &str| {
            server
                .and_then(|s| s.get(key))
                .and_then(Value::as_str)
                .unwrap_or("unknown")
                .to_string()
        };
        self.cfg.logger.info(&format!(
            "connected: daemon {} capabilities=[{}]",
            text("version"),
            capabilities.join(",")
        ));
        self.set_state(ConnectionState::Connected {
            server_version: text("version"),
            server_platform: text("platform"),
            protocol: PROTOCOL_VERSION,
            capabilities,
            features: strings(hello.get("features")),
        });

        // --- suscripciones y bucle --------------------------------------------
        let end = match conn.open_overview().await {
            Err(_) => End::Lost,
            Ok(()) => self.pump(&mut conn, &mut lines).await,
        };
        conn.fail_pending();
        match &end {
            End::Lost => self.cfg.logger.warn("disconnected from the daemon"),
            End::Shutdown => self
                .cfg
                .logger
                .info("closing the connection (dot is quitting)"),
            _ => {}
        }
        end
    }

    async fn pump(&mut self, conn: &mut Conn, lines: &mut mpsc::Receiver<String>) -> End {
        let mut tick = tokio::time::interval(Duration::from_millis(500));
        loop {
            let step = tokio::select! {
                line = lines.recv() => match line {
                    None => return End::Lost,
                    Some(line) => self.on_line(conn, &line).await,
                },
                cmd = self.next_cmd() => match cmd {
                    None => return End::Shutdown,
                    Some(cmd) => self.on_cmd(conn, cmd).await,
                },
                _ = tick.tick() => self.expire(conn),
            };
            match step {
                Ok(None) => {}
                Ok(Some(end)) => return end,
                Err(_) => return End::Lost,
            }
        }
    }

    /// Vence lo que lleva demasiado sin respuesta.
    fn expire(&mut self, conn: &mut Conn) -> std::io::Result<Option<End>> {
        let now = Instant::now();
        let late: Vec<u64> = conn
            .pending
            .iter()
            .filter(|(_, (_, at))| *at <= now)
            .map(|(id, _)| *id)
            .collect();
        for id in late {
            match conn.pending.remove(&id) {
                Some((Pending::Control { reply }, _)) => {
                    let _ = reply.send(Err(CommandError::new(
                        CommandErrorKind::Unknown,
                        "The daemon did not answer in time. Check the run state before trying again.",
                    )));
                }
                Some((Pending::Call { reply, mutating }, _)) => {
                    let _ = reply.send(Err(unanswered(
                        mutating,
                        "The daemon did not answer in time.",
                    )));
                }
                // Sin la suscripción de conjunto no se ve nada: se empieza de nuevo.
                Some((Pending::SubOverview { .. }, _)) => return Ok(Some(End::Lost)),
                Some((Pending::SubSession { session_id, .. }, _)) => {
                    self.cfg
                        .logger
                        .warn(&format!("subscription timed out session={session_id}"));
                }
                Some((Pending::Unsub, _)) | None => {}
            }
        }
        Ok(None)
    }

    fn publish_sessions(&self, conn: &Conn) {
        let ids = match self.cfg.profile.follow() {
            FollowPolicy::All => &conn.order,
            FollowPolicy::Focused => &conn.live,
        };
        self.shared.sessions.store(ids.len(), Ordering::Relaxed);
        self.emit(DotEvent::Sessions {
            session_ids: ids.clone(),
            unfollowed: conn.unfollowed.len(),
        });
    }

    /// Una sesión nueva en la foto de conjunto. `true` si cambió la lista.
    async fn joined(&mut self, conn: &mut Conn, session_id: &str) -> std::io::Result<bool> {
        match self.cfg.profile.follow() {
            FollowPolicy::All => self.follow(conn, session_id).await,
            FollowPolicy::Focused => {
                if conn.live.iter().any(|id| id == session_id) {
                    return Ok(false);
                }
                conn.live.push(session_id.to_string());
                if self.focus.as_deref() == Some(session_id) {
                    self.follow(conn, session_id).await?;
                }
                Ok(true)
            }
        }
    }

    /// Una sesión que deja de existir. `true` si cambió la lista.
    async fn left(&mut self, conn: &mut Conn, session_id: &str) -> std::io::Result<bool> {
        match self.cfg.profile.follow() {
            FollowPolicy::All => self.unfollow(conn, session_id).await,
            FollowPolicy::Focused => {
                self.unfollow(conn, session_id).await?;
                let before = conn.live.len();
                conn.live.retain(|id| id != session_id);
                Ok(conn.live.len() != before)
            }
        }
    }

    /// Si hay hueco, se siguen sesiones que esperaban. `true` si cambió algo.
    async fn promote(&mut self, conn: &mut Conn) -> std::io::Result<bool> {
        let mut changed = false;
        while conn.sessions.len() < MAX_FOLLOWED_SESSIONS {
            let Some(id) = conn.unfollowed.pop_front() else {
                break;
            };
            changed |= self.follow(conn, &id).await?;
        }
        Ok(changed)
    }

    async fn follow(&mut self, conn: &mut Conn, session_id: &str) -> std::io::Result<bool> {
        if conn.sessions.contains_key(session_id) {
            return Ok(false);
        }
        if conn.sessions.len() >= MAX_FOLLOWED_SESSIONS {
            if conn.unfollowed.iter().any(|id| id == session_id)
                || conn.unfollowed.len() >= MAX_UNFOLLOWED_TRACKED
            {
                return Ok(false);
            }
            self.cfg.logger.warn(&format!(
                "too many live sessions: not following {session_id}"
            ));
            conn.unfollowed.push_back(session_id.to_string());
            return Ok(true);
        }
        let volatile = self.focus.as_deref() == Some(session_id);
        conn.sessions
            .insert(session_id.to_string(), SessionSub::new(volatile));
        conn.order.push(session_id.to_string());
        conn.open_session(session_id).await?;
        Ok(true)
    }

    async fn unfollow(&mut self, conn: &mut Conn, session_id: &str) -> std::io::Result<bool> {
        let Some(sub) = conn.sessions.remove(session_id) else {
            let before = conn.unfollowed.len();
            conn.unfollowed.retain(|id| id != session_id);
            return Ok(conn.unfollowed.len() != before);
        };
        conn.order.retain(|id| id != session_id);
        if let Some(server_id) = sub.server_id {
            conn.unsubscribe(server_id).await?;
        }
        Ok(true)
    }

    async fn on_line(&mut self, conn: &mut Conn, line: &str) -> std::io::Result<Option<End>> {
        match wire::classify(line) {
            Incoming::Ignored => {}
            Incoming::Request { id } => conn.send(wire::method_not_found_line(&id)).await?,
            Incoming::ConnectionError(error) => {
                self.cfg.logger.warn(&format!(
                    "daemon reported a connection error ({})",
                    error.code
                ));
            }
            Incoming::Response { id, outcome } => {
                let Some((pending, _)) = conn.pending.remove(&id) else {
                    return Ok(None);
                };
                return self.on_response(conn, pending, outcome).await;
            }
            Incoming::Notification { method, mut params } => {
                if method == "goodbye" {
                    let reason = params
                        .get("reason")
                        .and_then(Value::as_str)
                        .unwrap_or("unknown");
                    self.cfg
                        .logger
                        .info(&format!("daemon said goodbye ({reason})"));
                    return Ok(None);
                }
                let Some(subscription) = params.get("subscriptionId").and_then(Value::as_str)
                else {
                    return Ok(None);
                };
                let session_id = match conn.routes.get(subscription) {
                    None => return Ok(None),
                    Some(Route::Overview) => None,
                    Some(Route::Session(id)) => Some(id.clone()),
                };
                match (method.as_str(), session_id) {
                    ("overview", None) => {
                        if self.cfg.profile.forward_overview() {
                            self.emit(DotEvent::Overview {
                                overview: params["overview"].clone(),
                            });
                        }
                        let ids = conn.overview.on_overview(&params["overview"]);
                        self.reconcile(conn, ids).await?;
                    }
                    ("events", None) => {
                        let events = params
                            .get("events")
                            .and_then(Value::as_array)
                            .cloned()
                            .unwrap_or_default();
                        if self.cfg.profile.forward_overview() && !events.is_empty() {
                            self.emit(DotEvent::OverviewEvents {
                                events: events.clone(),
                            });
                        }
                        let mut changed = false;
                        for change in conn.overview.on_events(&events) {
                            changed |= match change {
                                Membership::Opened(id) => self.joined(conn, &id).await?,
                                Membership::Closed(id) => self.left(conn, &id).await?,
                            };
                        }
                        changed |= self.promote(conn).await?;
                        if changed {
                            self.publish_sessions(conn);
                        }
                    }
                    ("events", Some(session_id)) => {
                        let events = match params.get_mut("events").map(Value::take) {
                            Some(Value::Array(events)) => events,
                            _ => return Ok(None),
                        };
                        let Some(sub) = conn.sessions.get_mut(&session_id) else {
                            return Ok(None);
                        };
                        let (deliver, resync) = sub.on_events(&session_id, events);
                        let volatile = sub.volatile;
                        if !deliver.is_empty() {
                            self.emit(DotEvent::Events {
                                session_id: session_id.clone(),
                                events: deliver,
                            });
                        }
                        if resync {
                            self.cfg.logger.warn(&format!(
                                "subscription resync session={session_id} reason=seq-gap"
                            ));
                            conn.reopen_session(&session_id, volatile).await?;
                        }
                    }
                    ("snapshot", Some(session_id)) => {
                        let snapshot = params
                            .get_mut("snapshot")
                            .map(Value::take)
                            .unwrap_or(Value::Null);
                        let Some(sub) = conn.sessions.get_mut(&session_id) else {
                            return Ok(None);
                        };
                        if sub.on_snapshot(&session_id, &snapshot) {
                            self.emit(DotEvent::Snapshot {
                                session_id,
                                snapshot,
                            });
                        }
                    }
                    _ => {}
                }
            }
        }
        Ok(None)
    }

    /// La foto de conjunto dice qué sesiones hay: se siguen esas y solo esas
    /// (con [`FollowPolicy::Focused`], de esas solo la enfocada).
    async fn reconcile(&mut self, conn: &mut Conn, mut ids: Vec<String>) -> std::io::Result<()> {
        if self.cfg.profile.follow() == FollowPolicy::Focused {
            let keep = self.focus.clone().filter(|id| ids.contains(id));
            let followed: Vec<String> = conn.order.clone();
            for id in followed {
                if Some(&id) != keep.as_ref() {
                    self.unfollow(conn, &id).await?;
                }
            }
            conn.live = ids;
            if let Some(id) = keep {
                self.follow(conn, &id).await?;
            }
            self.cfg
                .logger
                .info(&format!("overview: {} live session(s)", conn.live.len()));
            self.publish_sessions(conn);
            return Ok(());
        }
        conn.unfollowed.clear();
        if ids.len() > MAX_FOLLOWED_SESSIONS {
            self.cfg.logger.warn(&format!(
                "too many live sessions ({}): following the first {MAX_FOLLOWED_SESSIONS}",
                ids.len()
            ));
            conn.unfollowed = ids
                .split_off(MAX_FOLLOWED_SESSIONS)
                .into_iter()
                .take(MAX_UNFOLLOWED_TRACKED)
                .collect();
        }
        let gone: Vec<String> = conn
            .order
            .iter()
            .filter(|id| !ids.contains(id))
            .cloned()
            .collect();
        for id in gone {
            self.unfollow(conn, &id).await?;
        }
        for id in &ids {
            self.follow(conn, id).await?;
        }
        conn.order = ids;
        self.cfg
            .logger
            .info(&format!("overview: {} live session(s)", conn.order.len()));
        self.publish_sessions(conn);
        Ok(())
    }

    async fn on_response(
        &mut self,
        conn: &mut Conn,
        pending: Pending,
        outcome: Result<Value, WireError>,
    ) -> std::io::Result<Option<End>> {
        let subscription_id = |result: &Value| {
            result
                .get("subscriptionId")
                .and_then(Value::as_str)
                .map(str::to_string)
        };
        match pending {
            Pending::Unsub => {}
            Pending::SubOverview { generation } => match outcome {
                Err(error) => {
                    return Ok(Some(End::Fatal(format!(
                        "The Stratum daemon refused the overview subscription ({}).",
                        error.code
                    ))));
                }
                Ok(result) => {
                    let Some(server_id) = subscription_id(&result) else {
                        return Ok(Some(End::Lost));
                    };
                    if generation != conn.overview_generation {
                        // Se reabrió mientras tanto: esta ya no es la buena.
                        conn.unsubscribe(server_id).await?;
                    } else {
                        conn.routes.insert(server_id.clone(), Route::Overview);
                        conn.overview.server_id = Some(server_id);
                    }
                }
            },
            Pending::SubSession {
                session_id,
                generation,
            } => {
                let current = conn.sessions.get(&session_id).map(|s| s.generation);
                match outcome {
                    Ok(result) => {
                        let Some(server_id) = subscription_id(&result) else {
                            return Ok(None);
                        };
                        if current == Some(generation) {
                            conn.routes
                                .insert(server_id.clone(), Route::Session(session_id.clone()));
                            if let Some(sub) = conn.sessions.get_mut(&session_id) {
                                sub.server_id = Some(server_id);
                            }
                        } else {
                            conn.unsubscribe(server_id).await?;
                        }
                    }
                    Err(error) if current == Some(generation) => {
                        // La sesión ya no existe (o no se puede seguir): deja de contarse.
                        self.cfg.logger.warn(&format!(
                            "cannot follow session={session_id} ({})",
                            error.code
                        ));
                        conn.sessions.remove(&session_id);
                        conn.order.retain(|id| id != &session_id);
                        self.promote(conn).await?;
                        self.publish_sessions(conn);
                    }
                    Err(_) => {}
                }
            }
            Pending::Control { reply } => {
                let answer = match outcome {
                    Ok(result) => Ok(result
                        .get("status")
                        .and_then(Value::as_str)
                        .unwrap_or("ok")
                        .to_string()),
                    Err(error) => Err(CommandError {
                        kind: CommandErrorKind::Rejected,
                        code: Some(error.code),
                        reason: error.reason,
                        message: error.message,
                    }),
                };
                let _ = reply.send(answer);
            }
            Pending::Call { reply, .. } => {
                // El resultado es un DTO del protocolo: pasa sin tocar.
                let _ = reply.send(outcome.map_err(|error| CommandError {
                    kind: CommandErrorKind::Rejected,
                    code: Some(error.code),
                    reason: error.reason,
                    message: error.message,
                }));
            }
        }
        Ok(None)
    }

    async fn on_cmd(&mut self, conn: &mut Conn, cmd: Cmd) -> std::io::Result<Option<End>> {
        match cmd {
            Cmd::Shutdown => return Ok(Some(End::Shutdown)),
            // Ya hay conexión: reintentar no tiene nada que hacer.
            Cmd::Retry => self.emit(DotEvent::Connection {
                state: self.state(),
            }),
            Cmd::Attach => {
                self.emit(DotEvent::Connection {
                    state: self.state(),
                });
                // Todo se reabre: la interfaz recibe una foto de cada sesión.
                let followed: Vec<String> = conn.order.clone();
                for id in followed {
                    self.unfollow(conn, &id).await?;
                }
                if let Some(server_id) = conn.overview.server_id.take() {
                    conn.unsubscribe(server_id).await?;
                }
                conn.overview = OverviewSub::default();
                conn.open_overview().await?;
            }
            Cmd::Focus(focus) if self.cfg.profile.follow() == FollowPolicy::Focused => {
                if focus == self.focus {
                    return Ok(None);
                }
                let previous = std::mem::replace(&mut self.focus, focus.clone());
                // Solo se sigue lo que se mira: la anterior se suelta entera.
                if let Some(id) = previous {
                    self.unfollow(conn, &id).await?;
                }
                if let Some(id) = focus {
                    if conn.live.contains(&id) {
                        self.follow(conn, &id).await?;
                    }
                }
            }
            Cmd::Focus(focus) => {
                if focus == self.focus {
                    return Ok(None);
                }
                let previous = std::mem::replace(&mut self.focus, focus.clone());
                if let Some(id) = previous {
                    if conn.sessions.get(&id).map(|s| s.volatile).unwrap_or(false) {
                        conn.reopen_session(&id, false).await?;
                    }
                }
                if let Some(id) = focus {
                    conn.reopen_session(&id, true).await?;
                }
            }
            Cmd::Resync(session_id) => {
                if let Some(volatile) = conn.sessions.get(&session_id).map(|s| s.volatile) {
                    self.cfg.logger.info(&format!(
                        "subscription resync session={session_id} reason=requested"
                    ));
                    conn.reopen_session(&session_id, volatile).await?;
                }
            }
            // Acotado: con demasiado en vuelo, no sale nada más.
            Cmd::Control(_, reply) if conn.in_flight() >= MAX_IN_FLIGHT => {
                let _ = reply.send(Err(busy()));
            }
            Cmd::Call(_, reply) if conn.in_flight() >= MAX_IN_FLIGHT => {
                let _ = reply.send(Err(busy()));
            }
            Cmd::Control(action, reply) => {
                let request = if conn.can_control {
                    control_request(&action)
                        .and_then(|(method, params)| self.allowed(method).map(|_| (method, params)))
                } else {
                    Err(CommandError::new(
                        CommandErrorKind::NotSent,
                        "The Stratum daemon did not grant this client the right to control runs.",
                    ))
                };
                match request {
                    Err(error) => {
                        let _ = reply.send(Err(error));
                    }
                    Ok((method, params)) => {
                        self.cfg.logger.info(&format!("control: {}", action.name()));
                        conn.request(method, params, Pending::Control { reply })
                            .await?;
                    }
                }
            }
            Cmd::Call(action, reply) => {
                let mutating = action.mutating();
                let request = if mutating && !conn.can_control {
                    Err(CommandError::new(
                        CommandErrorKind::NotSent,
                        "The Stratum daemon did not grant this client the right to control sessions.",
                    ))
                } else {
                    self.operations += 1;
                    let operation_id = format!("{}-{}", self.operation_prefix, self.operations);
                    call_request(&action, &operation_id)
                        .and_then(|(method, params)| self.allowed(method).map(|_| (method, params)))
                };
                match request {
                    Err(error) => {
                        let _ = reply.send(Err(error));
                    }
                    Ok((method, params)) => {
                        // Sin el contenido: ni el mensaje ni la ruta van al log.
                        self.cfg.logger.info(&format!("call: {}", action.name()));
                        let timeout = match action {
                            CallAction::OpenSession { .. } => self.cfg.timings.open_timeout,
                            _ => self.cfg.timings.request_timeout,
                        };
                        conn.request_within(
                            method,
                            params,
                            Pending::Call { reply, mutating },
                            timeout,
                        )
                        .await?;
                    }
                }
            }
        }
        Ok(None)
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
    fn las_ordenes_se_traducen_a_su_metodo() {
        let (method, params) = control_request(&ControlAction::Pause {
            session_id: "ses_1".into(),
            run_id: Some("run_1".into()),
        })
        .unwrap();
        assert_eq!(method, MainMethod::RunsPause);
        assert_eq!(params, json!({ "sessionId": "ses_1", "runId": "run_1" }));

        let (method, params) = control_request(&ControlAction::Steer {
            session_id: "ses_1".into(),
            text: "hola".into(),
        })
        .unwrap();
        assert_eq!(method, MainMethod::RunsSteer);
        assert_eq!(params, json!({ "sessionId": "ses_1", "text": "hola" }));

        let (method, params) = control_request(&ControlAction::Cancel {
            session_id: "ses_1".into(),
            run_id: None,
        })
        .unwrap();
        assert_eq!(method, MainMethod::RunsCancel);
        assert_eq!(params, json!({ "sessionId": "ses_1" }));
    }

    #[test]
    fn las_llamadas_se_traducen_a_su_metodo() {
        let (method, params) = call_request(
            &CallAction::OpenSession {
                cwd: Some("  /work/proj ".into()),
                agent: Some(String::new()),
                provider: None,
                model: Some("m1".into()),
            },
            "op-1",
        )
        .unwrap();
        assert_eq!(method, MainMethod::SessionsOpen);
        // Lo vacío no se pide; nunca viaja un `env`, un `resume` ni nada más.
        assert_eq!(
            params,
            json!({ "cwd": "/work/proj", "model": "m1", "operationId": "op-1" })
        );

        let (method, params) = call_request(
            &CallAction::OpenSession {
                cwd: None,
                agent: None,
                provider: None,
                model: None,
            },
            "op-2",
        )
        .unwrap();
        assert_eq!(method, MainMethod::SessionsOpen);
        assert_eq!(params, json!({ "operationId": "op-2" }));

        let (method, params) = call_request(
            &CallAction::StartRun {
                session_id: "ses_1".into(),
                input: "hola\nmundo".into(),
            },
            "op-3",
        )
        .unwrap();
        assert_eq!(method, MainMethod::RunsStart);
        assert_eq!(
            params,
            json!({ "sessionId": "ses_1", "input": "hola\nmundo", "operationId": "op-3" })
        );

        let (method, params) = call_request(&CallAction::ListModels, "x").unwrap();
        assert_eq!((method, params), (MainMethod::ModelsList, json!({})));
        let (method, params) = call_request(
            &CallAction::ListAgents {
                cwd: Some("/w".into()),
            },
            "x",
        )
        .unwrap();
        assert_eq!(
            (method, params),
            (MainMethod::AgentsList, json!({ "cwd": "/w" }))
        );
    }

    #[test]
    fn una_llamada_que_no_cabe_no_se_envia_ni_se_recorta() {
        let bad = [
            CallAction::StartRun {
                session_id: String::new(),
                input: "hola".into(),
            },
            CallAction::StartRun {
                session_id: "ses".into(),
                input: "   ".into(),
            },
            CallAction::StartRun {
                session_id: "ses".into(),
                input: "x".repeat(MAX_INPUT_CHARS + 1),
            },
            CallAction::OpenSession {
                cwd: Some("x".repeat(MAX_PATH_CHARS + 1)),
                agent: None,
                provider: None,
                model: None,
            },
            CallAction::OpenSession {
                cwd: None,
                agent: Some("x".repeat(MAX_NAME_CHARS + 1)),
                provider: None,
                model: None,
            },
        ];
        for action in bad {
            assert_eq!(
                call_request(&action, "op").unwrap_err().kind,
                CommandErrorKind::Invalid,
                "{}",
                action.name()
            );
        }
    }

    #[test]
    fn argumentos_que_no_valen_no_se_envian() {
        let bad = [
            ControlAction::Pause {
                session_id: String::new(),
                run_id: None,
            },
            ControlAction::Resume {
                session_id: "x".repeat(MAX_ID_CHARS + 1),
                run_id: None,
            },
            ControlAction::Cancel {
                session_id: "ses".into(),
                run_id: Some(String::new()),
            },
            ControlAction::Steer {
                session_id: "ses".into(),
                text: "x".repeat(MAX_INPUT_CHARS + 1),
            },
        ];
        for action in bad {
            assert_eq!(
                control_request(&action).unwrap_err().kind,
                CommandErrorKind::Invalid,
                "{action:?}"
            );
        }
    }
}
