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
        },
        page(10),
    ] {
        let err = dot_rig.link.call(action).await.unwrap_err();
        assert_eq!(err.kind, CommandErrorKind::Invalid);
    }
    assert_eq!(fake.count("sessions.close"), 0);
    assert_eq!(fake.count("sessions.setModel"), 0);

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
