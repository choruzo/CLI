//! Lo que sale de este cliente hacia quien lo usa (la app o `dot-probe`).
//!
//! Todo lo de aquí se serializa y **llega al webview**: ningún tipo lleva el
//! token del canal, la ruta del pipe, la del endpoint ni la clave de aprobador.

use serde::Serialize;
use serde_json::Value;

use crate::approver::ApproverStatus;

/// Estado de la conexión con el daemon. Una máquina de estados, no una
/// colección de booleanos: en cada momento vale exactamente una variante.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum ConnectionState {
    /// Dot acaba de arrancar (o se pidió reintentar) y aún no sabe si hay daemon.
    Starting,
    /// No había daemon y Dot lo está arrancando (`stratum daemon start`).
    DaemonStarting,
    Connecting,
    Connected {
        server_version: String,
        server_platform: String,
        protocol: u64,
        /// Capacidades **concedidas**: pueden ser menos de las pedidas.
        capabilities: Vec<String>,
        features: Vec<String>,
    },
    /// Hubo conexión y se perdió: se reintenta solo, sin arrancar el daemon.
    Reconnecting {
        attempt: u32,
    },
    /// El daemon habla otra versión del protocolo. No se intenta conectar.
    Incompatible {
        client_protocol: u64,
        /// `None` si el daemon no dijo cuál habla.
        daemon_protocol: Option<u64>,
        daemon_version: Option<String>,
    },
    /// No hay conexión y Dot no la está estableciendo. Si aparece un daemon, se
    /// conecta solo; `retry` lo vuelve a intentar desde el principio.
    Error {
        message: String,
    },
}

impl ConnectionState {
    pub fn is_connected(&self) -> bool {
        matches!(self, ConnectionState::Connected { .. })
    }

    /// Para los logs: el nombre del estado, sin datos.
    pub fn name(&self) -> &'static str {
        match self {
            ConnectionState::Starting => "starting",
            ConnectionState::DaemonStarting => "daemon-starting",
            ConnectionState::Connecting => "connecting",
            ConnectionState::Connected { .. } => "connected",
            ConnectionState::Reconnecting { .. } => "reconnecting",
            ConnectionState::Incompatible { .. } => "incompatible",
            ConnectionState::Error { .. } => "error",
        }
    }
}

/// Canal nativo → interfaz. `snapshot` y `events` llevan DTOs del protocolo sin
/// tocar (ya redactados por el anfitrión de la sesión): quien los recibe los
/// valida contra el contrato antes de usarlos.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum DotEvent {
    Connection {
        state: ConnectionState,
    },
    /// Las sesiones vivas que conoce el daemon. **Sustituye**: una sesión que no
    /// está aquí ya no existe para Dot.
    Sessions {
        session_ids: Vec<String>,
        /// Sesiones vivas que Dot **no** sigue porque ya sigue
        /// [`crate::link::MAX_FOLLOWED_SESSIONS`]: la lista es parcial y la
        /// interfaz lo dice. `0` = se sigue todo lo que hay.
        unfollowed: usize,
    },
    /// Foto de una sesión: sustituye lo que se tuviera de ella.
    Snapshot {
        session_id: String,
        snapshot: Value,
    },
    /// Eventos posteriores a la última foto, en orden y sin repetidos.
    Events {
        session_id: String,
        events: Vec<Value>,
    },
    /// Estado de la autoridad de aprobar (`crate::approver`). Sin datos: ni la
    /// clave ni nada derivado de ella.
    Approver {
        status: ApproverStatus,
    },
    /// M12 — la foto de conjunto **sin interpretar** (estado operativo de todas
    /// las sesiones, sin conversaciones). Sustituye a la anterior. Solo con un
    /// perfil que la reenvía ([`crate::link::ClientProfile::forward_overview`]).
    Overview {
        overview: Value,
    },
    /// M12 — eventos de la suscripción de conjunto, sin interpretar, en orden.
    OverviewEvents {
        events: Vec<Value>,
    },
}

/// Órdenes que Dot puede dar sobre un run. No hay más: es la lista blanca.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ControlAction {
    Pause {
        session_id: String,
        run_id: Option<String>,
    },
    Resume {
        session_id: String,
        run_id: Option<String>,
    },
    Cancel {
        session_id: String,
        run_id: Option<String>,
    },
    Steer {
        session_id: String,
        text: String,
    },
}

impl ControlAction {
    pub fn name(&self) -> &'static str {
        match self {
            ControlAction::Pause { .. } => "pause",
            ControlAction::Resume { .. } => "resume",
            ControlAction::Cancel { .. } => "cancel",
            ControlAction::Steer { .. } => "steer",
        }
    }
}

/// Llamadas cuyo resultado es un DTO del protocolo. Aquí **no se interpreta**:
/// vuelve tal cual a quien llama, que lo valida contra el contrato. Abrir una
/// sesión del daemon, iniciar un run en ella, consultar qué perfiles y modelos
/// se pueden elegir y, para Desktop (M12), leer su historial, contexto y
/// memoria, cerrarla y cambiarle el modelo. Qué puede usar cada cliente lo
/// dice su perfil ([`crate::link::ClientProfile`]): Dot no cierra sesiones.
///
/// Lo que no cabe, a propósito: variables de entorno para la sesión (su
/// entorno es el del daemon) ni un `resume`.
///
/// `ListPending` y `GetSession` son consultas del lado nativo: las usa la
/// confirmación nativa ([`crate::confirm`]) para leer **del daemon** qué se va
/// a resolver. Ningún comando del webview las expone.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CallAction {
    /// `sessions.open`. Todo opcional: lo que falte lo decide el daemon.
    OpenSession {
        cwd: Option<String>,
        agent: Option<String>,
        provider: Option<String>,
        model: Option<String>,
    },
    /// `runs.start`: un mensaje del usuario es un run nuevo de esa sesión.
    StartRun { session_id: String, input: String },
    /// `agents.list`, con los perfiles de proyecto de ese directorio.
    ListAgents { cwd: Option<String> },
    /// `models.list`.
    ListModels,
    /// M12 — `skills.list`: las skills disponibles para un agente (`agent`, y
    /// `cwd` para las de proyecto). Solo lectura.
    ListSkills {
        agent: Option<String>,
        cwd: Option<String>,
    },
    /// `approvals.list` de una sesión: lo que tiene pendiente, según el daemon.
    ListPending { session_id: String },
    /// `sessions.get`: la foto de una sesión (su directorio, su título).
    GetSession { session_id: String },
    /// M12 — `sessions.history`: una página de la conversación guardada, hacia
    /// atrás desde `before` (un id de mensaje), o la última.
    History {
        session_id: String,
        before: Option<String>,
        limit: Option<u32>,
    },
    /// M12 — `sessions.context`: qué recibe el modelo ahora.
    Context { session_id: String },
    /// M12 — `sessions.memory`: la memoria de sesión.
    Memory { session_id: String },
    /// M12 — `sessions.close`: cerrarla. En el daemon también deja de estar guardada.
    CloseSession { session_id: String },
    /// M12 — `sessions.setModel`: otro modelo (y, si se da, otro provider)
    /// para una sesión parada.
    SetModel {
        session_id: String,
        model: String,
        provider: Option<String>,
    },
}

impl CallAction {
    pub fn name(&self) -> &'static str {
        match self {
            CallAction::OpenSession { .. } => "open-session",
            CallAction::StartRun { .. } => "start-run",
            CallAction::ListAgents { .. } => "list-agents",
            CallAction::ListModels => "list-models",
            CallAction::ListSkills { .. } => "list-skills",
            CallAction::ListPending { .. } => "list-pending",
            CallAction::GetSession { .. } => "get-session",
            CallAction::History { .. } => "history",
            CallAction::Context { .. } => "context",
            CallAction::Memory { .. } => "memory",
            CallAction::CloseSession { .. } => "close-session",
            CallAction::SetModel { .. } => "set-model",
        }
    }

    /// Cambia algo: sin respuesta, su resultado es desconocido y no se repite.
    pub fn mutating(&self) -> bool {
        matches!(
            self,
            CallAction::OpenSession { .. }
                | CallAction::StartRun { .. }
                | CallAction::CloseSession { .. }
                | CallAction::SetModel { .. }
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CommandErrorKind {
    /// Los argumentos no valen. No se envió nada.
    Invalid,
    /// No salió: sin conexión, o sin la capacidad `control`. Repetir es seguro.
    NotSent,
    /// Salió y no hubo respuesta (conexión caída o plazo vencido): **no se sabe**
    /// si se aplicó. No se reenvía: el estado dirá qué pasó.
    Unknown,
    /// Una **consulta** salió y no hubo respuesta. No cambió nada: repetir es seguro.
    NoAnswer,
    /// El daemon (o el anfitrión de la sesión) contestó con un error.
    Rejected,
    /// Una resolución sensible que la persona **no confirmó** en la ventana
    /// nativa (la canceló, caducó, o la solicitud o la autoridad cambiaron
    /// mientras tanto). No se envió nada. `reason` dice cuál
    /// ([`crate::confirm::CancelReason`]).
    NotConfirmed,
}

/// Por qué no se pudo dar una orden.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandError {
    pub kind: CommandErrorKind,
    /// Código del protocolo (`UNAVAILABLE`, `STALE_STATE`…), solo con `rejected`.
    pub code: Option<String>,
    /// `data.reason` del error (`host-unavailable`, `peer-hosted`).
    pub reason: Option<String>,
    pub message: String,
}

impl CommandError {
    pub fn new(kind: CommandErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            code: None,
            reason: None,
            message: message.into(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn el_estado_se_serializa_con_kind() {
        assert_eq!(
            serde_json::to_value(ConnectionState::DaemonStarting).unwrap(),
            json!({ "kind": "daemon-starting" })
        );
        assert_eq!(
            serde_json::to_value(ConnectionState::Reconnecting { attempt: 2 }).unwrap(),
            json!({ "kind": "reconnecting", "attempt": 2 })
        );
        assert_eq!(
            serde_json::to_value(ConnectionState::Incompatible {
                client_protocol: 1,
                daemon_protocol: Some(2),
                daemon_version: Some("1.0.0".into())
            })
            .unwrap(),
            json!({ "kind": "incompatible", "clientProtocol": 1, "daemonProtocol": 2, "daemonVersion": "1.0.0" })
        );
    }

    #[test]
    fn los_eventos_se_serializan_con_type() {
        assert_eq!(
            serde_json::to_value(DotEvent::Sessions {
                session_ids: vec!["a".into()],
                unfollowed: 0,
            })
            .unwrap(),
            json!({ "type": "sessions", "sessionIds": ["a"], "unfollowed": 0 })
        );
        assert_eq!(
            serde_json::to_value(DotEvent::Snapshot {
                session_id: "a".into(),
                snapshot: json!({ "seq": 1 })
            })
            .unwrap(),
            json!({ "type": "snapshot", "sessionId": "a", "snapshot": { "seq": 1 } })
        );
    }

    #[test]
    fn solo_abrir_e_iniciar_cambian_algo() {
        let open = CallAction::OpenSession {
            cwd: None,
            agent: None,
            provider: None,
            model: None,
        };
        let start = CallAction::StartRun {
            session_id: "s".into(),
            input: "hola".into(),
        };
        assert!(open.mutating() && start.mutating());
        assert!(!CallAction::ListModels.mutating());
        assert!(!CallAction::ListSkills {
            agent: None,
            cwd: None
        }
        .mutating());
        assert!(!CallAction::ListAgents { cwd: None }.mutating());
        assert!(!CallAction::ListPending {
            session_id: "s".into()
        }
        .mutating());
        assert!(!CallAction::GetSession {
            session_id: "s".into()
        }
        .mutating());
        assert_eq!(
            serde_json::to_value(CommandErrorKind::NotConfirmed).unwrap(),
            json!("not-confirmed")
        );
        assert_eq!(
            serde_json::to_value(CommandErrorKind::NoAnswer).unwrap(),
            json!("no-answer")
        );
    }

    #[test]
    fn el_error_de_una_orden() {
        let err = CommandError::new(CommandErrorKind::NotSent, "x");
        assert_eq!(
            serde_json::to_value(err).unwrap(),
            json!({ "kind": "not-sent", "code": null, "reason": null, "message": "x" })
        );
    }
}
