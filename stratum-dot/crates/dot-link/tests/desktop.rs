//! M12 — el mismo enlace con el perfil de Stratum Desktop
//! ([`ClientProfile::DESKTOP`]) contra un daemon de pruebas sobre un pipe real:
//! se presenta como `desktop`, sigue **solo** la sesión que se mira (la lista
//! sale de la foto de conjunto, sin transcripts), usa lo de M11 y puede cerrar
//! una sesión; y el perfil de Dot sigue sin poder hacerlo.

mod common;

use common::*;
use dot_link::{CallAction, ClientProfile, CommandErrorKind, DotEvent};
use serde_json::json;

fn connected(rig: &Rig) -> bool {
    rig.link.connection().is_connected()
}

/// Suscripciones de sesión que el enlace pidió, por id de sesión.
fn session_subscriptions(fake: &Fake) -> Vec<String> {
    fake.requests()
        .into_iter()
        .filter(|r| r["method"] == "events.subscribe" && r["params"]["scope"]["kind"] == "session")
        .filter_map(|r| {
            r["params"]["scope"]["sessionId"]
                .as_str()
                .map(str::to_string)
        })
        .collect()
}

fn overviews(rig: &Rig) -> usize {
    rig.seen
        .all()
        .into_iter()
        .filter(|e| matches!(e, DotEvent::Overview { .. }))
        .count()
}

#[tokio::test(flavor = "multi_thread")]
async fn se_presenta_como_desktop_y_sigue_solo_la_sesion_enfocada() {
    let dir = tempfile::tempdir().unwrap();
    let fake = Fake::new(dir.path());
    fake.set_session(snapshot("s1", 3));
    fake.set_session(snapshot("s2", 5));
    fake.start(TOKEN_A, 1);

    let rig = client(dir.path(), None, ClientProfile::DESKTOP);
    until("conectado", || connected(&rig)).await;
    until("lista", || rig.seen.last_sessions().is_some()).await;

    let hello = &fake.requests()[0];
    assert_eq!(hello["params"]["client"]["kind"], "desktop");
    assert_eq!(hello["params"]["client"]["name"], "stratum-desktop");
    // Mínima autoridad, como Dot: nunca aprobar.
    assert_eq!(hello["params"]["roles"], json!(["operator"]));

    // La lista tiene las dos, y la foto de conjunto llega sin interpretar…
    assert_eq!(
        rig.seen.last_sessions(),
        Some(vec!["s1".to_string(), "s2".to_string()])
    );
    assert_eq!(overviews(&rig), 1);
    // …pero no se pide la conversación de ninguna hasta mirarla.
    assert!(session_subscriptions(&fake).is_empty());
    assert!(rig.seen.snapshots("s1").is_empty());

    rig.link.focus(Some("s2".into()));
    until("foto de s2", || !rig.seen.snapshots("s2").is_empty()).await;
    assert_eq!(session_subscriptions(&fake), ["s2"]);
    let sub = fake
        .requests()
        .into_iter()
        .find(|r| r["params"]["scope"]["sessionId"] == "s2")
        .unwrap();
    assert_eq!(sub["params"]["scope"]["volatile"], true);

    // Cambiar de sesión suelta la anterior.
    rig.link.focus(Some("s1".into()));
    until("foto de s1", || !rig.seen.snapshots("s1").is_empty()).await;
    until("baja de s2", || fake.count("events.unsubscribe") >= 1).await;
    assert_eq!(session_subscriptions(&fake), ["s2", "s1"]);

    // Una sesión nueva entra en la lista sin suscribirse a ella.
    let opened = rig
        .link
        .call(CallAction::OpenSession {
            cwd: Some("/work".into()),
            agent: Some("assistant".into()),
            provider: None,
            model: None,
        })
        .await
        .unwrap();
    let id = opened["session"]["id"].as_str().unwrap().to_string();
    until("en la lista", || {
        rig.seen
            .last_sessions()
            .is_some_and(|ids| ids.contains(&id))
    })
    .await;
    assert_eq!(session_subscriptions(&fake), ["s2", "s1"]);
    rig.quit().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn usa_lo_de_m11_y_cierra_sesiones_pero_dot_no_puede() {
    let dir = tempfile::tempdir().unwrap();
    let fake = Fake::new(dir.path());
    fake.set_session(snapshot("s1", 3));
    fake.start(TOKEN_A, 1);

    let desktop = client(dir.path(), None, ClientProfile::DESKTOP);
    let dot_rig = dot(dir.path(), None);
    until("conectados", || connected(&desktop) && connected(&dot_rig)).await;

    let history = desktop
        .link
        .call(CallAction::History {
            session_id: "s1".into(),
            before: None,
            limit: Some(50),
        })
        .await
        .unwrap();
    assert_eq!(history["hasMore"], false);
    desktop
        .link
        .call(CallAction::Context {
            session_id: "s1".into(),
        })
        .await
        .unwrap();
    desktop
        .link
        .call(CallAction::Memory {
            session_id: "s1".into(),
        })
        .await
        .unwrap();
    let page = |limit| CallAction::History {
        session_id: "s1".into(),
        before: None,
        limit: Some(limit),
    };
    let err = desktop.link.call(page(0)).await.unwrap_err();
    assert_eq!(err.kind, CommandErrorKind::Invalid);

    // Dot: ni cerrar ni cambiar el modelo, y no sale nada hacia el daemon.
    for action in [
        CallAction::CloseSession {
            session_id: "s1".into(),
        },
        CallAction::SetModel {
            session_id: "s1".into(),
            model: "otro".into(),
            provider: None,
        },
        page(10),
    ] {
        let err = dot_rig.link.call(action).await.unwrap_err();
        assert_eq!(err.kind, CommandErrorKind::Invalid);
    }
    assert_eq!(fake.count("sessions.close"), 0);
    assert_eq!(fake.count("sessions.setModel"), 0);

    // Desktop sí cambia modelo y provider; sin provider, el campo no viaja.
    for provider in [Some("otro-provider"), None] {
        desktop
            .link
            .call(CallAction::SetModel {
                session_id: "s1".into(),
                model: "otro".into(),
                provider: provider.map(str::to_string),
            })
            .await
            .unwrap();
        let sent = fake
            .requests()
            .into_iter()
            .rev()
            .find(|r| r["method"] == "sessions.setModel")
            .unwrap();
        assert_eq!(sent["params"]["model"], "otro");
        match provider {
            Some(p) => assert_eq!(sent["params"]["provider"], p),
            None => assert!(sent["params"].get("provider").is_none()),
        }
    }

    // Desktop sí, con su `operationId`; la sesión desaparece de las dos listas por eventos.
    desktop
        .link
        .call(CallAction::CloseSession {
            session_id: "s1".into(),
        })
        .await
        .unwrap();
    let close = fake
        .requests()
        .into_iter()
        .find(|r| r["method"] == "sessions.close")
        .unwrap();
    assert!(close["params"]["operationId"]
        .as_str()
        .is_some_and(|op| !op.is_empty()));
    until("fuera de la lista de Desktop", || {
        desktop.seen.last_sessions() == Some(vec![])
    })
    .await;
    until("fuera de la lista de Dot", || {
        dot_rig.seen.last_sessions() == Some(vec![])
    })
    .await;
    desktop.quit().await;
    dot_rig.quit().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn cerrar_sin_respuesta_queda_desconocido_y_no_se_reenvia() {
    let dir = tempfile::tempdir().unwrap();
    let fake = Fake::new(dir.path());
    fake.set_session(snapshot("s1", 3));
    fake.set_silent("sessions.close");
    fake.start(TOKEN_A, 1);

    let rig = client(dir.path(), None, ClientProfile::DESKTOP);
    until("conectado", || connected(&rig)).await;
    let link = rig.link.clone();
    let pending = tokio::spawn(async move {
        link.call(CallAction::CloseSession {
            session_id: "s1".into(),
        })
        .await
    });
    until("enviada", || fake.count("sessions.close") == 1).await;
    // Se cae la conexión con la orden en vuelo: el resultado no se sabe.
    fake.kill_connections_with("control");
    let err = pending.await.unwrap().unwrap_err();
    assert_eq!(err.kind, CommandErrorKind::Unknown);
    until("reconectado", || {
        connected(&rig) && fake.count("core.hello") >= 2
    })
    .await;
    // Al volver solo se reabren las suscripciones: la orden no se repite.
    assert_eq!(fake.count("sessions.close"), 1);
    rig.quit().await;
}

/// Lotes de traza que ha recibido la «interfaz», en orden: `(sesión, reset, nº de registros)`.
fn trace_batches(rig: &Rig) -> Vec<(String, bool, usize)> {
    rig.seen
        .all()
        .into_iter()
        .filter_map(|e| match e {
            DotEvent::TraceRecords {
                session_id,
                reset,
                records,
                ..
            } => Some((session_id, reset, records.len())),
            _ => None,
        })
        .collect()
}

fn trace_unavailable(rig: &Rig) -> Vec<(String, String, Option<String>)> {
    rig.seen
        .all()
        .into_iter()
        .filter_map(|e| match e {
            DotEvent::TraceUnavailable {
                session_id,
                code,
                reason,
            } => Some((session_id, code, reason)),
            _ => None,
        })
        .collect()
}

fn invalid_traces(rig: &Rig) -> usize {
    trace_unavailable(rig)
        .iter()
        .filter(|(_, code, _)| code == "INVALID_TRACE")
        .count()
}

#[tokio::test(flavor = "multi_thread")]
async fn la_traza_se_sigue_de_la_sesion_pedida_y_se_reabre_al_reconectar() {
    let dir = tempfile::tempdir().unwrap();
    let fake = Fake::new(dir.path());
    fake.set_session(snapshot("s1", 3));
    fake.set_session(snapshot("s2", 5));
    fake.start(TOKEN_A, 1);

    let rig = client(dir.path(), None, ClientProfile::DESKTOP);
    until("conectado", || connected(&rig)).await;
    // Sin pedirla, no se suscribe a ninguna traza.
    assert_eq!(fake.count("trace.subscribe"), 0);

    rig.link.trace(Some("s1".into()));
    until("reset de s1", || {
        trace_batches(&rig) == [("s1".to_string(), true, 0)]
    })
    .await;
    let sent = fake
        .requests()
        .into_iter()
        .find(|r| r["method"] == "trace.subscribe")
        .unwrap();
    assert_eq!(sent["params"], json!({ "sessionId": "s1" }));

    // Lo nuevo llega sin interpretar y sin `reset`.
    fake.push_trace(
        "s1",
        false,
        vec![
            json!({ "t": "turn", "at": 1, "input": "hola" }),
            json!({ "t": "turn_end", "at": 2, "stopReason": "stop" }),
        ],
    );
    until("registros", || trace_batches(&rig).len() == 2).await;
    assert_eq!(trace_batches(&rig)[1], ("s1".to_string(), false, 2));

    // Pedir otra suelta la anterior y abre la nueva.
    rig.link.trace(Some("s2".into()));
    until("reset de s2", || {
        trace_batches(&rig).contains(&("s2".to_string(), true, 0))
    })
    .await;
    until("baja de s1", || fake.trace_followers("s1") == 0).await;
    assert_eq!(fake.count("trace.unsubscribe"), 1);

    // El daemon se cae y vuelve: la traza pedida se abre otra vez (con `reset`).
    fake.kill_connections_with("control");
    until("reconectado", || {
        connected(&rig) && fake.count("core.hello") >= 2
    })
    .await;
    until("traza reabierta", || fake.count("trace.subscribe") == 3).await;
    until("reset tras reconectar", || trace_batches(&rig).len() == 4).await;
    assert_eq!(
        trace_batches(&rig).last().unwrap(),
        &("s2".to_string(), true, 0)
    );

    // Dejar de mirarla la suelta.
    rig.link.trace(None);
    until("sin seguidores", || fake.trace_followers("s2") == 0).await;
    rig.quit().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn una_traza_que_el_daemon_no_sirve_se_dice_y_no_se_reintenta() {
    let dir = tempfile::tempdir().unwrap();
    let fake = Fake::new(dir.path());
    fake.set_session(snapshot("s1", 3));
    fake.start(TOKEN_A, 1);

    let rig = client(dir.path(), None, ClientProfile::DESKTOP);
    until("conectado", || connected(&rig)).await;

    // La de una sesión par la escribe su proceso: `UNAVAILABLE` / `peer-hosted`.
    rig.link.trace(Some("peer".into()));
    until("no disponible", || {
        trace_unavailable(&rig)
            == [(
                "peer".to_string(),
                "UNAVAILABLE".to_string(),
                Some("peer-hosted".to_string()),
            )]
    })
    .await;
    rig.link.trace(Some("no-existe".into()));
    until("desconocida", || trace_unavailable(&rig).len() == 2).await;
    assert_eq!(trace_unavailable(&rig)[1].1, "NOT_FOUND");
    assert_eq!(fake.count("trace.subscribe"), 2);
    assert!(trace_batches(&rig).is_empty());
    rig.quit().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn un_lote_que_no_cumple_el_sobre_suelta_la_traza() {
    let dir = tempfile::tempdir().unwrap();
    let fake = Fake::new(dir.path());
    fake.set_session(snapshot("s1", 3));
    fake.start(TOKEN_A, 1);

    let rig = client(dir.path(), None, ClientProfile::DESKTOP);
    until("conectado", || connected(&rig)).await;
    rig.link.trace(Some("s1".into()));
    until("reset", || trace_batches(&rig).len() == 1).await;

    // `reset` que no es booleano: ni se reenvía ni se sigue.
    fake.push_trace_params("s1", |sub| {
        json!({ "subscriptionId": sub, "sessionId": "s1", "reset": "si", "format": 1, "records": [] })
    });
    until("suelta", || invalid_traces(&rig) == 1).await;
    until("baja", || fake.trace_followers("s1") == 0).await;
    assert_eq!(trace_batches(&rig).len(), 1);

    // Un registro que no es un objeto, tampoco.
    rig.link.trace(None);
    rig.link.trace(Some("s1".into()));
    until("reabierta", || trace_batches(&rig).len() == 2).await;
    fake.push_trace("s1", false, vec![json!("no soy un registro")]);
    until("suelta otra vez", || invalid_traces(&rig) == 2).await;

    // Ni más registros de la cuenta.
    rig.link.trace(None);
    rig.link.trace(Some("s1".into()));
    until("reabierta de nuevo", || trace_batches(&rig).len() == 3).await;
    let many: Vec<_> = (0..=dot_link::link::MAX_TRACE_RECORDS_PER_BATCH)
        .map(|i| json!({ "t": "turn", "at": i, "input": "x" }))
        .collect();
    fake.push_trace("s1", false, many);
    until("demasiados", || invalid_traces(&rig) == 3).await;
    rig.quit().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn dot_no_sigue_trazas_aunque_se_lo_pidan() {
    let dir = tempfile::tempdir().unwrap();
    let fake = Fake::new(dir.path());
    fake.set_session(snapshot("s1", 3));
    fake.start(TOKEN_A, 1);

    let rig = dot(dir.path(), None);
    until("conectado", || connected(&rig)).await;
    rig.link.trace(Some("s1".into()));
    // Pasa por el bucle: el foco se atiende después de la traza pedida.
    rig.link.focus(Some("s1".into()));
    until("foto", || !rig.seen.snapshots("s1").is_empty()).await;
    assert_eq!(fake.count("trace.subscribe"), 0);
    assert!(trace_batches(&rig).is_empty());
    rig.quit().await;
}
