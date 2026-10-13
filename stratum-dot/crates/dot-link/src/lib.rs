//! Cliente nativo del Stratum Protocol v1 para Stratum Dot.
//!
//! Qué hace: descubrir el daemon, conectar, hacer el handshake, mantener las
//! suscripciones (una de conjunto y una por sesión viva), reconectar y relevar
//! cuatro órdenes sobre un run (`pause`, `resume`, `cancel`, `steer`) y cuatro
//! llamadas para conversar (`sessions.open`, `runs.start`, `agents.list`,
//! `models.list`), cuyo resultado pasa sin interpretar.
//!
//! Qué **no** hace, a propósito: no interpreta los DTOs del protocolo ni
//! reduce eventos. Solo lee el sobre de cada mensaje y los campos de orden
//! (`seq`, `after`, `sessionId`, `type`); lo demás pasa tal cual a quien
//! consume [`DotEvent`], que lo valida y lo reduce con el contrato de
//! `stratum-cli/src/protocol/` (`schemas.ts`, `reduce.ts`).
//!
//! No depende de Tauri: lo usan la app (`src-tauri`) y `dot-probe`, el mismo
//! cliente sin ventana con el que se prueba contra un `stratumd` real.
//!
//! Referencia del contrato: `docs/protocol.md`. Arquitectura de Dot: `docs/dot.md`.

pub mod discovery;
pub mod framing;
pub mod launcher;
pub mod link;
pub mod log;
pub mod state;
pub mod subscriptions;
pub mod transport;
pub mod wire;

pub use launcher::{CliLauncher, DaemonLauncher, NoLauncher};
pub use link::{spawn, LinkConfig, LinkHandle};
pub use log::Logger;
pub use state::{
    CallAction, CommandError, CommandErrorKind, ConnectionState, ControlAction, DotEvent,
};

/// Versión del protocolo que habla este cliente (`STRATUM_PROTOCOL_VERSION`).
pub const PROTOCOL_VERSION: u64 = 1;

/// Tope de un mensaje autenticado (`MAX_MESSAGE_BYTES`).
pub const MAX_MESSAGE_BYTES: usize = 1024 * 1024;

/// Entrada de un mensaje de steering (`LIMITS.inputChars`).
pub const MAX_INPUT_CHARS: usize = 200_000;

/// Identificadores opacos (`LIMITS.idChars`).
pub const MAX_ID_CHARS: usize = 128;

/// Ruta absoluta de un `cwd` (`LIMITS.pathChars`).
pub const MAX_PATH_CHARS: usize = 4_096;

/// Nombre de perfil, modelo o provider (`LIMITS.nameChars`).
pub const MAX_NAME_CHARS: usize = 256;
