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

/// Métodos de la **conexión principal** de un cliente (`operator`: observar y
/// conducir). Es una lista cerrada: no existe forma de enviar un método que no
/// esté aquí, y `core.shutdown` no está —cerrar un cliente nunca apaga el
/// daemon— ni ninguno que exija la capacidad `approve`: esos son de
/// [`ApproverMethod`], que va por otra conexión.
///
/// Cada cliente usa además **su** subconjunto ([`crate::link::ClientProfile`]):
/// Dot puede abrir una sesión e iniciar sus runs, pero no cerrarla ni cambiarle
/// el modelo; Desktop (M12), sí, y lee el historial, el contexto y la memoria
/// de sesión (M11). Lo que no está en el perfil no se envía.
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
    /// M12 (Desktop) — la conversación guardada, por páginas (M11).
    SessionsHistory,
    /// M12 (Desktop) — qué recibe el modelo ahora (M11).
    SessionsContext,
    /// M12 (Desktop) — la memoria de sesión (M11).
    SessionsMemory,
    /// M12 (Desktop) — cerrar una sesión (en el daemon, también la borra del disco).
    SessionsClose,
    /// M12 (Desktop) — cambiar el modelo de una sesión parada.
    SessionsSetModel,
    /// M12 (Desktop) — las skills disponibles para un agente.
    SkillsList,
    /// M14 (Dot) — estado de la caja del asistente (M13).
    BoxStatus,
    /// M14 (Dot) — arrancar la caja (la crea, o la recrea si quedó desfasada).
    BoxStart,
    /// M14 (Dot) — pararla. `box.reset` (borra su home) no está: no es de un cliente.
    BoxStop,
    /// M15 (Dot) — la pantalla de la caja ahora (JPEG), para verla en solo lectura.
    BoxScreen,
    /// Dot — una imagen que el asistente comparte en la conversación, por trozos (`observe`).
    ImagesGet,
    /// M16 (Dot) — las rutinas del asistente (`docs/protocol.md` §23).
    RoutinesList,
    RoutinesAdd,
    RoutinesUpdate,
    RoutinesRemove,
    RoutinesRun,
    /// M17 (Dot) — revocar una concesión vigente (capacidad `control`, solo resta).
    GrantsRevoke,
    /// M17 (Dot) — inspector de memoria del asistente: las decisiones (`observe`).
    MemoryDecisions,
    /// M17 (Dot) — olvidar una decisión del asistente (`control`, solo resta).
    MemoryForget,
    /// M19 — mover un recuerdo de la memoria del asistente a otra sección
    /// (`control`; no cambia lo que el agente puede hacer).
    MemoryReclassify,
    /// M19 — las propuestas de dreaming pendientes de la memoria del asistente (`observe`).
    MemoryProposals,
    /// M19 — pedir una pasada de dreaming: solo propone (`control`; gasta modelo).
    MemoryDream,
    /// M19 — aplicar una propuesta: lo que cambia la memoria (`control`, como olvidar).
    MemoryApplyProposal,
    /// M19 — rechazar una propuesta: la memoria no se toca (`control`).
    MemoryRejectProposal,
    /// M18 (Dot) — el canal de Telegram: estado (sin token ni código), pedir un
    /// código de emparejamiento y desemparejar (solo resta). Emparejar de verdad
    /// (`channels.pairConfirm`) da autoridad: va por [`ApproverMethod`].
    ChannelsStatus,
    ChannelsPairBegin,
    ChannelsUnpair,
    /// Desktop: la traza de una sesión (`trace.records`, `observe`) para el panel
    /// de trayectoria. Solo lectura; la suscripción la lleva el enlace (sigue lo
    /// que se le pide con `LinkHandle::trace`), no una llamada suelta.
    TraceSubscribe,
    TraceUnsubscribe,
    /// Desktop (modo código) — el perfil de agente de código de una sesión parada
    /// (`null` lo quita). No elige un agente embebido: eso es al abrirla.
    SessionsSetAgent,
    /// Desktop (modo código) — solo lectura de una sesión parada (`control`).
    SessionsSetReadOnly,
    /// Desktop (modo código) — cancelar un job en segundo plano de una sesión
    /// (`control`; solo resta: para un proceso).
    JobsCancel,
    /// Desktop (modo código) — los cambios del working tree del proyecto de una
    /// sesión, y el diff de uno de sus ficheros (`observe`, solo lectura).
    GitChanges,
    GitDiff,
    /// Desktop (modo código) — el navegador del agente de una sesión: su estado
    /// y la pestaña en JPEG (`observe`, solo lectura; nunca lo arranca).
    BrowserScreen,
    /// Desktop (modo código) — la persona mueve ese navegador (`control`): solo
    /// lo local o ya aprobado; aprobar orígenes no es de un cliente.
    BrowserNavigate,
    /// Desktop (modo código) — el perfil de sesión (`code`, `infra`, `full`,
    /// `auto`…) de una sesión parada (`control`): qué tools ve el modelo.
    SessionsSetProfile,
    /// Desktop (modo código) — cómo está montada una sesión: perfil, tools,
    /// servers MCP, plugins y entornos (`observe`, solo lectura; no monta nada).
    SessionsInspect,
    /// Desktop (modo código) — pregunta lateral (`/btw`): el modelo contesta sin
    /// tools y nada entra en la conversación (`control`: gasta modelo).
    SessionsAsk,
    /// Desktop (modo código) — los turnos que se pueden deshacer (`observe`).
    SessionsTurns,
    /// Desktop (modo código) — pasar a job el comando en primer plano (`control`).
    JobsBackground,
    /// Desktop (modo código) — los `STRATUM.md` que ve la sesión (`observe`).
    MemoryDocuments,
}

impl MainMethod {
    pub const ALL: [MainMethod; 55] = [
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
        MainMethod::SkillsList,
        MainMethod::BoxStatus,
        MainMethod::BoxStart,
        MainMethod::BoxStop,
        MainMethod::BoxScreen,
        MainMethod::ImagesGet,
        MainMethod::RoutinesList,
        MainMethod::RoutinesAdd,
        MainMethod::RoutinesUpdate,
        MainMethod::RoutinesRemove,
        MainMethod::RoutinesRun,
        MainMethod::GrantsRevoke,
        MainMethod::MemoryDecisions,
        MainMethod::MemoryForget,
        MainMethod::MemoryReclassify,
        MainMethod::MemoryProposals,
        MainMethod::MemoryDream,
        MainMethod::MemoryApplyProposal,
        MainMethod::MemoryRejectProposal,
        MainMethod::ChannelsStatus,
        MainMethod::ChannelsPairBegin,
        MainMethod::ChannelsUnpair,
        MainMethod::TraceSubscribe,
        MainMethod::TraceUnsubscribe,
        MainMethod::SessionsSetAgent,
        MainMethod::SessionsSetReadOnly,
        MainMethod::JobsCancel,
        MainMethod::GitChanges,
        MainMethod::GitDiff,
        MainMethod::BrowserScreen,
        MainMethod::BrowserNavigate,
        MainMethod::SessionsSetProfile,
        MainMethod::SessionsInspect,
        MainMethod::SessionsAsk,
        MainMethod::SessionsTurns,
        MainMethod::JobsBackground,
        MainMethod::MemoryDocuments,
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
            MainMethod::SessionsHistory => "sessions.history",
            MainMethod::SessionsContext => "sessions.context",
            MainMethod::SessionsMemory => "sessions.memory",
            MainMethod::SessionsClose => "sessions.close",
            MainMethod::SessionsSetModel => "sessions.setModel",
            MainMethod::SkillsList => "skills.list",
            MainMethod::BoxStatus => "box.status",
            MainMethod::BoxStart => "box.start",
            MainMethod::BoxStop => "box.stop",
            MainMethod::BoxScreen => "box.screen",
            MainMethod::ImagesGet => "images.get",
            MainMethod::RoutinesList => "routines.list",
            MainMethod::RoutinesAdd => "routines.add",
            MainMethod::RoutinesUpdate => "routines.update",
            MainMethod::RoutinesRemove => "routines.remove",
            MainMethod::RoutinesRun => "routines.run",
            MainMethod::GrantsRevoke => "grants.revoke",
            MainMethod::MemoryDecisions => "memory.decisions",
            MainMethod::MemoryForget => "memory.forget",
            MainMethod::MemoryReclassify => "memory.reclassify",
            MainMethod::MemoryProposals => "memory.proposals",
            MainMethod::MemoryDream => "memory.dream",
            MainMethod::MemoryApplyProposal => "memory.applyProposal",
            MainMethod::MemoryRejectProposal => "memory.rejectProposal",
            MainMethod::ChannelsStatus => "channels.status",
            MainMethod::ChannelsPairBegin => "channels.pairBegin",
            MainMethod::ChannelsUnpair => "channels.unpair",
            MainMethod::TraceSubscribe => "trace.subscribe",
            MainMethod::TraceUnsubscribe => "trace.unsubscribe",
            MainMethod::SessionsSetAgent => "sessions.setAgent",
            MainMethod::SessionsSetReadOnly => "sessions.setReadOnly",
            MainMethod::JobsCancel => "jobs.cancel",
            MainMethod::GitChanges => "git.changes",
            MainMethod::GitDiff => "git.diff",
            MainMethod::BrowserScreen => "browser.screen",
            MainMethod::BrowserNavigate => "browser.navigate",
            MainMethod::SessionsSetProfile => "sessions.setProfile",
            MainMethod::SessionsInspect => "sessions.inspect",
            MainMethod::SessionsAsk => "sessions.ask",
            MainMethod::SessionsTurns => "sessions.turns",
            MainMethod::JobsBackground => "jobs.background",
            MainMethod::MemoryDocuments => "memory.documents",
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
    /// M18 — emparejar el candidato de Telegram: da autoridad (hablar con el
    /// asistente y aprobar desde el chat), así que exige `approve` y la
    /// confirmación nativa, como aprobar.
    ChannelsPairConfirm,
    /// Desktop (modo código) — deshacer los ficheros de los últimos turnos de una
    /// sesión (`sessions.revert`): pisa ficheros sin pasar por las aprobaciones,
    /// así que exige `approve`. El plan (`dryRun`) también va por aquí: el
    /// daemon pide la misma capacidad para calcularlo.
    SessionsRevert,
}

impl ApproverMethod {
    pub const ALL: [ApproverMethod; 6] = [
        ApproverMethod::CoreHello,
        ApproverMethod::ApprovalsResolve,
        ApproverMethod::QuestionsAnswer,
        ApproverMethod::PlansDecide,
        ApproverMethod::ChannelsPairConfirm,
        ApproverMethod::SessionsRevert,
    ];
}

impl WireMethod for ApproverMethod {
    fn name(self) -> &'static str {
        match self {
            ApproverMethod::CoreHello => "core.hello",
            ApproverMethod::ApprovalsResolve => "approvals.resolve",
            ApproverMethod::QuestionsAnswer => "questions.answer",
            ApproverMethod::PlansDecide => "plans.decide",
            ApproverMethod::ChannelsPairConfirm => "channels.pairConfirm",
            ApproverMethod::SessionsRevert => "sessions.revert",
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
                "sessions.get",
                "sessions.history",
                "sessions.context",
                "sessions.memory",
                "sessions.close",
                "sessions.setModel",
                "skills.list",
                "box.status",
                "box.start",
                "box.stop",
                "box.screen",
                "images.get",
                "routines.list",
                "routines.add",
                "routines.update",
                "routines.remove",
                "routines.run",
                "grants.revoke",
                "memory.decisions",
                "memory.forget",
                "memory.reclassify",
                "memory.proposals",
                "memory.dream",
                "memory.applyProposal",
                "memory.rejectProposal",
                "channels.status",
                "channels.pairBegin",
                "channels.unpair",
                "trace.subscribe",
                "trace.unsubscribe",
                "sessions.setAgent",
                "sessions.setReadOnly",
                "jobs.cancel",
                "git.changes",
                "git.diff",
                "browser.screen",
                "browser.navigate",
                "sessions.setProfile",
                "sessions.inspect",
                "sessions.ask",
                "sessions.turns",
                "jobs.background",
                "memory.documents"
            ]
        );
        for forbidden in [
            "core.shutdown",
            "approvals.resolve",
            "questions.answer",
            "plans.decide",
            // Emparejar da autoridad: solo por la conexión de aprobador.
            "channels.pairConfirm",
            "channels.reload",
            "sessions.detach",
            // Deshacer turnos exige `approve`: solo por la conexión de aprobador.
            "sessions.revert",
            "jobs.list",
            // Borra el home de la caja: lo hace la persona desde la CLI, que pide su nombre.
            "box.reset",
        ] {
            assert!(!names.contains(&forbidden), "{forbidden}");
        }
        for name in names {
            // Ni alojar, ni gobernar jobs, ni la memoria global: eso no es de un
            // cliente. Excepciones: ver, olvidar y reclasificar la del asistente
            // (M17, M19) y cancelar un job (modo código de Desktop: solo resta).
            // Modo código de Desktop, lo que la persona hace en `chat` con Ctrl+B y
            // `/memory show`: pasar a job el comando en primer plano (no lanza nada
            // ni relaja ninguna guarda) y leer los `STRATUM.md` de la sesión.
            let companion_memory = name == "memory.decisions"
                || name == "memory.forget"
                || name == "memory.reclassify"
                || name == "memory.proposals"
                || name == "memory.dream"
                || name == "memory.applyProposal"
                || name == "memory.rejectProposal"
                || name == "memory.documents";
            assert!(
                !name.starts_with("host.")
                    && (!name.starts_with("jobs.")
                        || name == "jobs.cancel"
                        || name == "jobs.background")
                    && (!name.starts_with("memory.") || companion_memory),
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
                "plans.decide",
                "channels.pairConfirm",
                "sessions.revert"
            ]
        );
        // Separación en los dos sentidos: lo que una tiene, la otra no (salvo el saludo).
        // De `sessions.*`, solo deshacer turnos, que exige `approve`.
        for method in ApproverMethod::ALL {
            let name = method.name();
            assert!(
                !name.starts_with("runs.")
                    && (!name.starts_with("sessions.") || name == "sessions.revert")
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
