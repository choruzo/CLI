//! El sobre de los mensajes (`docs/protocol.md` §3) y los métodos que este
//! cliente puede enviar. Nada más: el contenido de un resultado o de un evento
//! no se interpreta aquí.

use serde_json::{json, Value};

/// Lo que tiene un método que se puede escribir en una línea. Lo implementan
/// [`MainMethod`] y [`ApproverMethod`], y nada más: el rasgo está sellado.
pub trait WireMethod: Copy + sealed::Sealed {
    fn name(self) -> &'static str;
}

mod sealed {
    pub trait Sealed {}
    impl Sealed for super::MainMethod {}
    impl Sealed for super::ApproverMethod {}
}

/// Métodos de la **conexión principal** de Dot (`operator`: observar y
/// conducir runs). Es una lista cerrada: no existe forma de enviar un método
/// que no esté aquí, y `core.shutdown` no está —cerrar Dot nunca apaga el
/// daemon— ni ninguno que exija la capacidad `approve`: esos son de
/// [`ApproverMethod`], que va por otra conexión. De una sesión, Dot puede
/// **abrirla** e iniciar sus runs; cerrarla o cambiarle el modelo, no.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MainMethod {
    CoreHello,
    EventsSubscribe,
    EventsUnsubscribe,
    RunsPause,
    RunsResume,
    RunsCancel,
    RunsSteer,
    RunsStart,
    SessionsOpen,
    AgentsList,
    ModelsList,
    /// Lo pendiente de una sesión, para la confirmación nativa (`crate::confirm`).
    ApprovalsList,
    /// La foto de una sesión, para la confirmación nativa (su directorio, su título).
    SessionsGet,
}

impl MainMethod {
    pub const ALL: [MainMethod; 13] = [
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
}

impl WireMethod for MainMethod {
    fn name(self) -> &'static str {
        match self {
            MainMethod::CoreHello => "core.hello",
            MainMethod::EventsSubscribe => "events.subscribe",
            MainMethod::EventsUnsubscribe => "events.unsubscribe",
            MainMethod::RunsPause => "runs.pause",
            MainMethod::RunsResume => "runs.resume",
            MainMethod::RunsCancel => "runs.cancel",
            MainMethod::RunsSteer => "runs.steer",
            MainMethod::RunsStart => "runs.start",
            MainMethod::SessionsOpen => "sessions.open",
            MainMethod::AgentsList => "agents.list",
            MainMethod::ModelsList => "models.list",
            MainMethod::ApprovalsList => "approvals.list",
            MainMethod::SessionsGet => "sessions.get",
        }
    }
}

/// Métodos de la **conexión de aprobador** (`crate::approver`): saludar y
/// resolver. Nada de observar ni de conducir: ni `runs.*`, ni `sessions.*`, ni
/// suscripciones, ni `core.shutdown`. Resolver no se puede pedir por la
/// conexión principal ni conducir un run por esta: son tipos distintos.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApproverMethod {
    CoreHello,
    ApprovalsResolve,
    QuestionsAnswer,
    PlansDecide,
}

impl ApproverMethod {
    pub const ALL: [ApproverMethod; 4] = [
        ApproverMethod::CoreHello,
        ApproverMethod::ApprovalsResolve,
        ApproverMethod::QuestionsAnswer,
        ApproverMethod::PlansDecide,
    ];
}

impl WireMethod for ApproverMethod {
    fn name(self) -> &'static str {
        match self {
            ApproverMethod::CoreHello => "core.hello",
            ApproverMethod::ApprovalsResolve => "approvals.resolve",
            ApproverMethod::QuestionsAnswer => "questions.answer",
            ApproverMethod::PlansDecide => "plans.decide",
        }
    }
}

/// Una petición como línea NDJSON (con su `\n`).
pub fn request_line(id: u64, method: impl WireMethod, params: Value) -> String {
    let mut line = json!({ "id": id, "method": method.name(), "params": params }).to_string();
    line.push('\n');
    line
}

/// Respuesta a una petición del servidor: Dot no atiende ninguna.
pub fn method_not_found_line(id: &Value) -> String {
    let mut line = json!({
        "id": id,
        "error": { "code": "METHOD_NOT_FOUND", "message": "This client does not serve requests." }
    })
    .to_string();
    line.push('\n');
    line
}

/// Error de una respuesta, con lo único de `data` que este cliente usa.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WireError {
    pub code: String,
    pub message: String,
    /// `data.reason` (`host-unavailable`, `peer-hosted`…).
    pub reason: Option<String>,
    /// `data.protocol`, en un `PROTOCOL_MISMATCH`.
    pub protocol: Option<u64>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Incoming {
    Response {
        id: u64,
        outcome: Result<Value, WireError>,
    },
    Notification {
        method: String,
        params: Value,
    },
    /// El servidor pide algo. Se contesta `METHOD_NOT_FOUND`.
    Request {
        id: Value,
    },
    /// Un error sin `id` legible (`FRAME_TOO_LARGE`…): la conexión va a cerrarse.
    ConnectionError(WireError),
    /// No tiene forma de mensaje, o es una respuesta a un id que no es nuestro.
    Ignored,
}

fn wire_error(error: &Value) -> WireError {
    let text = |key: &str| {
        error
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string()
    };
    let data = error.get("data");
    WireError {
        code: text("code"),
        message: text("message"),
        reason: data
            .and_then(|d| d.get("reason"))
            .and_then(Value::as_str)
            .map(str::to_string),
        protocol: data.and_then(|d| d.get("protocol")).and_then(Value::as_u64),
    }
}

/// Clasifica una línea ya recibida. Mismas reglas que `messageKind`
/// (`protocol/messages.ts`); nuestros ids son siempre numéricos.
pub fn classify(line: &str) -> Incoming {
    let Ok(Value::Object(msg)) = serde_json::from_str::<Value>(line) else {
        return Incoming::Ignored;
    };
    let has_method = msg.get("method").map(Value::is_string).unwrap_or(false);
    let has_result = msg.contains_key("result");
    let has_error = msg.contains_key("error");
    if has_method {
        if has_result || has_error {
            return Incoming::Ignored;
        }
        return match msg.get("id") {
            None => Incoming::Notification {
                method: msg["method"].as_str().unwrap_or("").to_string(),
                params: msg.get("params").cloned().unwrap_or_else(|| json!({})),
            },
            Some(id) if id.is_string() || id.is_number() => Incoming::Request { id: id.clone() },
            Some(_) => Incoming::Ignored,
        };
    }
    if has_result == has_error {
        return Incoming::Ignored;
    }
    if has_error {
        let error = wire_error(&msg["error"]);
        return match msg.get("id") {
            Some(Value::Null) | None => Incoming::ConnectionError(error),
            Some(id) => match id.as_u64() {
                Some(id) => Incoming::Response {
                    id,
                    outcome: Err(error),
                },
                None => Incoming::Ignored,
            },
        };
    }
    match msg.get("id").and_then(Value::as_u64) {
        Some(id) => Incoming::Response {
            id,
            outcome: Ok(msg["result"].clone()),
        },
        None => Incoming::Ignored,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn la_lista_principal_es_cerrada_y_no_apaga_ni_aprueba() {
        let names: Vec<&str> = MainMethod::ALL.iter().map(|m| m.name()).collect();
        assert_eq!(
            names,
            [
                "core.hello",
                "events.subscribe",
                "events.unsubscribe",
                "runs.pause",
                "runs.resume",
                "runs.cancel",
                "runs.steer",
                "runs.start",
                "sessions.open",
                "agents.list",
                "models.list",
                "approvals.list",
                "sessions.get"
            ]
        );
        for forbidden in [
            "core.shutdown",
            "approvals.resolve",
            "questions.answer",
            "plans.decide",
            "sessions.close",
        ] {
            assert!(!names.contains(&forbidden), "{forbidden}");
        }
        for name in names {
            // De `sessions.*`, solo abrir y leer: ni cerrar ni reconfigurar una sesión viva.
            assert!(
                !name.starts_with("host.")
                    && !name.starts_with("sessions.set")
                    && !name.starts_with("jobs.")
                    && !name.starts_with("memory."),
                "{name}"
            );
        }
    }

    #[test]
    fn la_de_aprobador_solo_saluda_y_resuelve() {
        let names: Vec<&str> = ApproverMethod::ALL.iter().map(|m| m.name()).collect();
        assert_eq!(
            names,
            [
                "core.hello",
                "approvals.resolve",
                "questions.answer",
                "plans.decide"
            ]
        );
        // Separación en los dos sentidos: lo que una tiene, la otra no (salvo el saludo).
        for method in ApproverMethod::ALL {
            let name = method.name();
            assert!(
                !name.starts_with("runs.")
                    && !name.starts_with("sessions.")
                    && !name.starts_with("events.")
                    && !name.starts_with("host.")
                    && name != "core.shutdown",
                "{name}"
            );
            if name != "core.hello" {
                assert!(!MainMethod::ALL.iter().any(|m| m.name() == name), "{name}");
            }
        }
    }

    #[test]
    fn peticion_en_una_linea() {
        let line = request_line(7, MainMethod::RunsPause, json!({ "sessionId": "ses_1" }));
        assert!(line.ends_with('\n'));
        assert_eq!(line.matches('\n').count(), 1);
        let v: Value = serde_json::from_str(line.trim_end()).unwrap();
        assert_eq!(
            v,
            json!({ "id": 7, "method": "runs.pause", "params": { "sessionId": "ses_1" } })
        );
    }

    #[test]
    fn clasifica_respuestas() {
        assert_eq!(
            classify(r#"{"id":3,"result":{"status":"requested"}}"#),
            Incoming::Response {
                id: 3,
                outcome: Ok(json!({ "status": "requested" }))
            }
        );
        let Incoming::Response {
            id: 4,
            outcome: Err(err),
        } = classify(
            r#"{"id":4,"error":{"code":"UNAVAILABLE","message":"x","data":{"reason":"host-unavailable"}}}"#,
        )
        else {
            panic!("error response")
        };
        assert_eq!(err.code, "UNAVAILABLE");
        assert_eq!(err.reason.as_deref(), Some("host-unavailable"));
    }

    #[test]
    fn una_notificacion_no_es_una_respuesta() {
        assert_eq!(
            classify(r#"{"method":"goodbye","params":{"reason":"shutdown"}}"#),
            Incoming::Notification {
                method: "goodbye".into(),
                params: json!({ "reason": "shutdown" })
            }
        );
        assert_eq!(
            classify(r#"{"method":"events"}"#),
            Incoming::Notification {
                method: "events".into(),
                params: json!({})
            }
        );
    }

    #[test]
    fn peticion_del_servidor_y_error_sin_id() {
        assert_eq!(
            classify(r#"{"id":"s1","method":"host.cancel"}"#),
            Incoming::Request { id: json!("s1") }
        );
        assert!(matches!(
            classify(r#"{"id":null,"error":{"code":"FRAME_TOO_LARGE","message":"x"}}"#),
            Incoming::ConnectionError(_)
        ));
    }

    #[test]
    fn lo_que_no_es_un_mensaje_se_ignora() {
        for line in [
            "nope",
            "[]",
            "{}",
            r#"{"id":1}"#,
            r#"{"id":1,"result":1,"error":{}}"#,
            r#"{"id":"x","result":1}"#,
        ] {
            assert_eq!(classify(line), Incoming::Ignored, "{line}");
        }
    }

    #[test]
    fn mismatch_trae_la_version_del_servidor() {
        let Incoming::Response {
            outcome: Err(err), ..
        } = classify(
            r#"{"id":1,"error":{"code":"PROTOCOL_MISMATCH","message":"x","data":{"protocol":2}}}"#,
        )
        else {
            panic!()
        };
        assert_eq!(err.protocol, Some(2));
    }
}
