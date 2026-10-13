//! Lo que sale de este cliente hacia quien lo usa (la app o `dot-probe`).
//!
//! Todo lo de aquí se serializa y **llega al webview**: ningún tipo lleva el
//! token del canal, la ruta del pipe ni la del endpoint.

use serde::Serialize;
use serde_json::Value;

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
    /// El daemon (o el anfitrión de la sesión) contestó con un error.
    Rejected,
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
                session_ids: vec!["a".into()]
            })
            .unwrap(),
            json!({ "type": "sessions", "sessionIds": ["a"] })
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
    fn el_error_de_una_orden() {
        let err = CommandError::new(CommandErrorKind::NotSent, "x");
        assert_eq!(
            serde_json::to_value(err).unwrap(),
            json!({ "kind": "not-sent", "code": null, "reason": null, "message": "x" })
        );
    }
}
