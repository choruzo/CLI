//! El `ApproverBroker` contra un daemon de pruebas sobre un pipe real: la
//! autoridad de aprobar va por **otra** conexión, bajo demanda, y la clave
//! vive lo que dura el saludo.

mod common;

use common::*;
use dot_link::approver::{ApproverStatus, LockReason, Unavailable};
use dot_link::{ApproverAction, ApproverSecret, CommandErrorKind, QuestionAnswer};
use serde_json::Value;
use std::time::Duration;

fn key(text: &str) -> ApproverSecret {
    ApproverSecret::from_bytes(text.as_bytes().to_vec()).unwrap()
}

fn approval(id: &str, session: &str) -> PendingReq {
    PendingReq {
        id: id.into(),
        session_id: session.into(),
        kind: "approval",
        confirm_phrase: None,
    }
}

fn approve(session: &str, id: &str) -> ApproverAction {
    ApproverAction::Approve {
        session_id: session.into(),
        approval_id: id.into(),
        phrase: None,
        for_session: false,
    }
}

/// Saludos que pidieron el rol `approver`.
fn approver_hellos(fake: &Fake) -> Vec<Value> {
    fake.requests()
        .into_iter()
        .filter(|r| {
            r["method"] == "core.hello" && r["params"]["roles"] == serde_json::json!(["approver"])
        })
        .collect()
}

/// Un daemon con aprobadores, Dot conectado y el broker al tanto de ello.
async fn rig_with_key(dir: &std::path::Path) -> (Fake, Rig, BrokerRig) {
    let fake = Fake::new(dir);
    fake.set_approver_key(Some(APPROVER_KEY));
    fake.set_session(snapshot("ses_a", 1));
    fake.set_session(snapshot("ses_b", 1));
    fake.start(TOKEN_A, 1);
    let rig = dot(dir, None);
    until("conectado", || rig.link.connection().is_connected()).await;
    let b = broker(dir, fast_approver());
    b.broker.observe_main(&rig.link.connection());
    until("bloqueado", || b.status() == "locked").await;
    (fake, rig, b)
}

#[tokio::test]
async fn sin_clave_configurada_no_hay_a_quien_desbloquear() {
    let dir = tempfile::tempdir().unwrap();
    let fake = Fake::new(dir.path());
    fake.start(TOKEN_A, 1);
    let rig = dot(dir.path(), None);
    until("conectado", || rig.link.connection().is_connected()).await;
    let b = broker(dir.path(), fast_approver());
    // Sin conexión principal todavía, no está disponible.
    assert_eq!(
        b.broker.status(),
        ApproverStatus::Unavailable {
            reason: Unavailable::NotConnected
        }
    );
    b.broker.observe_main(&rig.link.connection());
    until("sin clave", || {
        b.broker.status()
            == ApproverStatus::Unavailable {
                reason: Unavailable::NoApproverKey,
            }
    })
    .await;
    let err = b.broker.unlock(key(APPROVER_KEY)).await.unwrap_err();
    assert_eq!(err.kind, CommandErrorKind::NotSent);
    // Dot no crea ninguna clave ni abre una conexión de aprobador.
    assert!(approver_hellos(&fake).is_empty());
    assert_eq!(fake.connections(), 1);
    b.quit().await;
    rig.quit().await;
}

#[tokio::test]
async fn desbloquear_abre_otra_conexion_solo_de_aprobador_y_resuelve_con_la_sesion() {
    let dir = tempfile::tempdir().unwrap();
    let (fake, rig, b) = rig_with_key(dir.path()).await;
    // Bajo demanda: hasta desbloquear, una sola conexión (la principal).
    assert_eq!(fake.connections(), 1);
    assert!(approver_hellos(&fake).is_empty());

    b.broker.unlock(key(APPROVER_KEY)).await.unwrap();
    assert!(matches!(b.broker.status(), ApproverStatus::Ready { .. }));
    assert_eq!(fake.connections(), 2);
    let hellos = approver_hellos(&fake);
    assert_eq!(hellos.len(), 1);
    assert_eq!(hellos[0]["params"]["client"]["kind"], "dot");
    assert_eq!(hellos[0]["params"]["approverKey"], APPROVER_KEY);
    // La principal sigue siendo `operator` y nunca llevó la clave.
    let main_hellos: Vec<Value> = fake
        .requests()
        .into_iter()
        .filter(|r| {
            r["method"] == "core.hello" && r["params"]["roles"] == serde_json::json!(["operator"])
        })
        .collect();
    assert_eq!(main_hellos.len(), 1);
    assert!(main_hellos[0]["params"].get("approverKey").is_none());
    assert_eq!(fake.live_with("approve"), 1);
    assert_eq!(fake.live_with("control"), 1);

    fake.add_pending(approval("apr_1", "ses_a"));
    b.broker.resolve(approve("ses_a", "apr_1")).await.unwrap();
    let sent = fake
        .requests()
        .into_iter()
        .find(|r| r["method"] == "approvals.resolve")
        .unwrap();
    assert_eq!(sent["params"]["sessionId"], "ses_a");
    assert_eq!(sent["params"]["decision"], "approve");
    assert!(sent["params"]["operationId"]
        .as_str()
        .unwrap()
        .starts_with("dot-approver-"));
    // Por la conexión de aprobador, no por la principal.
    assert_eq!(sent["conn"], hellos[0]["conn"]);
    b.quit().await;
    rig.quit().await;
}

#[tokio::test]
async fn una_clave_que_no_vale_da_un_error_generico_y_no_se_insiste() {
    let dir = tempfile::tempdir().unwrap();
    let (fake, rig, b) = rig_with_key(dir.path()).await;

    let err = b
        .broker
        .unlock(key("otra clave cualquiera"))
        .await
        .unwrap_err();
    assert_eq!(err.message, "Could not unlock approval authority.");
    assert_eq!(
        b.broker.status(),
        ApproverStatus::Error {
            message: "Could not unlock approval authority.".into()
        }
    );
    until("la conexión rechazada se cierra", || {
        fake.live_connections() == 1
    })
    .await;
    // Sin bucles: un segundo intento inmediato ni siquiera sale.
    let again = b.broker.unlock(key(APPROVER_KEY)).await.unwrap_err();
    assert_eq!(again.kind, CommandErrorKind::NotSent);
    assert_eq!(approver_hellos(&fake).len(), 1);
    // Pasado el momento, otra conexión nueva (la rechazada no se reutiliza).
    tokio::time::sleep(Duration::from_millis(350)).await;
    b.broker.unlock(key(APPROVER_KEY)).await.unwrap();
    assert_eq!(approver_hellos(&fake).len(), 2);
    assert_ne!(
        approver_hellos(&fake)[0]["conn"],
        approver_hellos(&fake)[1]["conn"]
    );
    b.quit().await;
    rig.quit().await;
}

#[tokio::test]
async fn sin_approve_concedido_no_se_da_por_desbloqueado() {
    let dir = tempfile::tempdir().unwrap();
    let (fake, rig, b) = rig_with_key(dir.path()).await;
    fake.withhold_approve();
    let err = b.broker.unlock(key(APPROVER_KEY)).await.unwrap_err();
    assert_eq!(err.message, "Could not unlock approval authority.");
    assert_eq!(b.status(), "error");
    fake.add_pending(approval("apr_1", "ses_a"));
    let err = b
        .broker
        .resolve(approve("ses_a", "apr_1"))
        .await
        .unwrap_err();
    assert_eq!(err.kind, CommandErrorKind::NotSent);
    assert_eq!(fake.count("approvals.resolve"), 0);
    b.quit().await;
    rig.quit().await;
}

#[tokio::test]
async fn bloqueado_no_se_envia_nada_y_bloquear_cierra_la_conexion() {
    let dir = tempfile::tempdir().unwrap();
    let (fake, rig, b) = rig_with_key(dir.path()).await;
    fake.add_pending(approval("apr_1", "ses_a"));
    let err = b
        .broker
        .resolve(approve("ses_a", "apr_1"))
        .await
        .unwrap_err();
    assert_eq!(err.kind, CommandErrorKind::NotSent);

    b.broker.unlock(key(APPROVER_KEY)).await.unwrap();
    assert_eq!(fake.live_with("approve"), 1);
    b.broker.lock();
    until("bloqueado a mano", || {
        b.broker.status()
            == ApproverStatus::Locked {
                reason: LockReason::Manual,
            }
    })
    .await;
    until("conexión de aprobador cerrada", || {
        fake.live_with("approve") == 0
    })
    .await;
    // Lo pendiente sigue ahí: solo se pierde la capacidad de resolverlo desde Dot.
    assert_eq!(fake.pending_ids(), ["apr_1"]);
    assert!(rig.link.connection().is_connected());
    assert_eq!(
        b.broker
            .resolve(approve("ses_a", "apr_1"))
            .await
            .unwrap_err()
            .kind,
        CommandErrorKind::NotSent
    );
    assert_eq!(fake.count("approvals.resolve"), 0);
    b.quit().await;
    rig.quit().await;
}

#[tokio::test]
async fn otra_via_llego_antes_y_un_id_de_otra_sesion_no_resuelve() {
    let dir = tempfile::tempdir().unwrap();
    let (fake, rig, b) = rig_with_key(dir.path()).await;
    b.broker.unlock(key(APPROVER_KEY)).await.unwrap();
    fake.add_pending(approval("apr_1", "ses_a"));

    // Id correcto, sesión equivocada: rechazado, y sigue pendiente.
    let err = b
        .broker
        .resolve(approve("ses_b", "apr_1"))
        .await
        .unwrap_err();
    assert_eq!(
        (err.kind, err.code.as_deref()),
        (CommandErrorKind::Rejected, Some("NOT_FOUND"))
    );
    assert_eq!(fake.pending_ids(), ["apr_1"]);

    // La terminal contesta primero: a Dot le llega `ALREADY_RESOLVED`.
    fake.resolve_elsewhere("apr_1");
    let err = b
        .broker
        .resolve(ApproverAction::Deny {
            session_id: "ses_a".into(),
            approval_id: "apr_1".into(),
        })
        .await
        .unwrap_err();
    assert_eq!(err.code.as_deref(), Some("ALREADY_RESOLVED"));
    // La autoridad sigue: un rechazo del daemon no bloquea.
    assert_eq!(b.status(), "ready");
    b.quit().await;
    rig.quit().await;
}

#[tokio::test]
async fn una_resolucion_sin_respuesta_es_desconocida_y_no_se_reenvia() {
    let dir = tempfile::tempdir().unwrap();
    let (fake, rig, b) = rig_with_key(dir.path()).await;
    b.broker.unlock(key(APPROVER_KEY)).await.unwrap();
    fake.add_pending(PendingReq {
        id: "q_1".into(),
        session_id: "ses_b".into(),
        kind: "question",
        confirm_phrase: None,
    });
    fake.set_silent("questions.answer");
    let err = b
        .broker
        .resolve(ApproverAction::AnswerQuestions {
            session_id: "ses_b".into(),
            request_id: "q_1".into(),
            answers: Some(vec![QuestionAnswer {
                question: "¿Cuál?".into(),
                answer: "respuesta privada".into(),
                option_id: None,
            }]),
        })
        .await
        .unwrap_err();
    assert_eq!(err.kind, CommandErrorKind::Unknown);
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(fake.count("questions.answer"), 1);
    // Las respuestas no van al log.
    assert!(!b.log().contains("respuesta privada"), "{}", b.log());
    b.quit().await;
    rig.quit().await;
}

#[tokio::test]
async fn si_cae_la_conexion_de_aprobador_la_principal_sigue_y_no_se_reconecta_sola() {
    let dir = tempfile::tempdir().unwrap();
    let (fake, rig, b) = rig_with_key(dir.path()).await;
    b.broker.unlock(key(APPROVER_KEY)).await.unwrap();
    fake.kill_connections_with("approve");
    until("bloqueado al perder la conexión", || {
        b.broker.status()
            == ApproverStatus::Locked {
                reason: LockReason::ConnectionLost,
            }
    })
    .await;
    // Dot sigue observando y controlando.
    assert!(rig.link.connection().is_connected());
    assert_eq!(fake.live_with("control"), 1);
    tokio::time::sleep(Duration::from_millis(300)).await;
    // No guarda la clave: no hay otra conexión de aprobador hasta que se desbloquee otra vez.
    assert_eq!(approver_hellos(&fake).len(), 1);
    b.broker.unlock(key(APPROVER_KEY)).await.unwrap();
    assert_eq!(approver_hellos(&fake).len(), 2);
    fake.add_pending(approval("apr_9", "ses_a"));
    b.broker.resolve(approve("ses_a", "apr_9")).await.unwrap();
    b.quit().await;
    rig.quit().await;
}

#[tokio::test]
async fn un_daemon_nuevo_exige_desbloquear_otra_vez() {
    let dir = tempfile::tempdir().unwrap();
    let (fake, rig, b) = rig_with_key(dir.path()).await;
    b.broker.unlock(key(APPROVER_KEY)).await.unwrap();
    fake.stop(true);
    until("bloqueado", || b.status() == "locked").await;
    fake.start(TOKEN_B, 1);
    until("la principal vuelve", || {
        rig.link.connection().is_connected()
    })
    .await;
    b.broker.observe_main(&rig.link.connection());
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(b.status(), "locked");
    assert_eq!(approver_hellos(&fake).len(), 1);
    fake.add_pending(approval("apr_1", "ses_a"));
    assert_eq!(
        b.broker
            .resolve(approve("ses_a", "apr_1"))
            .await
            .unwrap_err()
            .kind,
        CommandErrorKind::NotSent
    );
    // Con el daemon nuevo hay que acreditarse de nuevo (con su token, que Dot relee).
    b.broker.unlock(key(APPROVER_KEY)).await.unwrap();
    assert_eq!(
        approver_hellos(&fake).last().unwrap()["params"]["token"],
        TOKEN_B
    );
    b.quit().await;
    rig.quit().await;
}

#[tokio::test]
async fn el_desbloqueo_caduca_solo() {
    let dir = tempfile::tempdir().unwrap();
    let (fake, rig, _) = rig_with_key(dir.path()).await;
    let mut timings = fast_approver();
    timings.unlocked_for = Duration::from_millis(400);
    let b = broker(dir.path(), timings);
    b.broker.observe_main(&rig.link.connection());
    until("bloqueado", || b.status() == "locked").await;
    b.broker.unlock(key(APPROVER_KEY)).await.unwrap();
    let ApproverStatus::Ready { expires_at } = b.broker.status() else {
        panic!("ready")
    };
    assert!(expires_at > 0);
    until("caducado", || {
        b.broker.status()
            == ApproverStatus::Locked {
                reason: LockReason::Expired,
            }
    })
    .await;
    until("conexión cerrada", || fake.live_with("approve") == 0).await;
    b.quit().await;
    rig.quit().await;
}

#[tokio::test]
async fn la_clave_no_sale_por_ningun_lado() {
    let dir = tempfile::tempdir().unwrap();
    let (fake, rig, b) = rig_with_key(dir.path()).await;
    let _ = b
        .broker
        .unlock(key("clave-equivocada-que-no-debe-verse"))
        .await;
    tokio::time::sleep(Duration::from_millis(350)).await;
    b.broker.unlock(key(APPROVER_KEY)).await.unwrap();
    fake.add_pending(PendingReq {
        id: "apr_2".into(),
        session_id: "ses_a".into(),
        kind: "approval",
        confirm_phrase: Some("frase-secreta-prod".into()),
    });
    let err = b
        .broker
        .resolve(ApproverAction::Approve {
            session_id: "ses_a".into(),
            approval_id: "apr_2".into(),
            phrase: Some("no".into()),
            for_session: false,
        })
        .await
        .unwrap_err();
    assert_eq!(err.code.as_deref(), Some("INVALID_PARAMS"));
    b.broker
        .resolve(ApproverAction::Approve {
            session_id: "ses_a".into(),
            approval_id: "apr_2".into(),
            phrase: Some("frase-secreta-prod".into()),
            for_session: false,
        })
        .await
        .unwrap();

    // Lo que llega a la interfaz (los `DotEvent`, serializados), los dos logs y el estado.
    let wire = serde_json::to_string(&[b.seen.all(), rig.seen.all()].concat()).unwrap();
    let logs = format!("{}\n{}", b.log(), rig.log());
    let status = serde_json::to_string(&b.broker.status()).unwrap();
    for secret in [
        APPROVER_KEY,
        "clave-equivocada-que-no-debe-verse",
        "frase-secreta-prod",
        TOKEN_A,
    ] {
        assert!(!wire.contains(secret), "{secret} en DotEvent");
        assert!(!logs.contains(secret), "{secret} en el log");
        assert!(!status.contains(secret), "{secret} en el estado");
    }
    // Qué se registró: el intento, el resultado y el tipo de resolución.
    assert!(b.log().contains("approver: unlock attempt"));
    assert!(b.log().contains("approver: unlock failed (UNAUTHORIZED)"));
    assert!(b.log().contains("approver: resolve approve request=apr_2"));
    b.quit().await;
    rig.quit().await;
}

#[tokio::test]
async fn cerrar_dot_suelta_la_autoridad_y_no_toca_nada_mas() {
    let dir = tempfile::tempdir().unwrap();
    let (fake, rig, b) = rig_with_key(dir.path()).await;
    b.broker.unlock(key(APPROVER_KEY)).await.unwrap();
    fake.add_pending(approval("apr_1", "ses_a"));
    b.quit().await;
    rig.quit().await;
    until("sin conexiones", || fake.live_connections() == 0).await;
    // Ni resolvió, ni canceló, ni cerró: lo pendiente sigue pendiente.
    assert_eq!(fake.pending_ids(), ["apr_1"]);
    for method in [
        "approvals.resolve",
        "runs.cancel",
        "sessions.close",
        "core.shutdown",
    ] {
        assert_eq!(fake.count(method), 0, "{method}");
    }
}
