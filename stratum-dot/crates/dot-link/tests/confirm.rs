//! La confirmación nativa (M9) contra el daemon de pruebas: un webview que
//! pide resolver no basta; hace falta que la persona confirme en la superficie
//! nativa, con la autoridad de ese desbloqueo y la solicitud aún pendiente.

mod common;

use common::*;
use dot_link::approver::{ApproverStatus, LockReason, NEEDS_CONFIRMATION};
use dot_link::{
    ApproverAction, ApproverSecret, CancelReason, CommandErrorKind, ConfirmGate, ConfirmTimings,
    Logger, QuestionAnswer,
};
use serde_json::json;
use std::sync::Arc;
use std::time::Duration;

fn key() -> ApproverSecret {
    ApproverSecret::from_bytes(APPROVER_KEY.as_bytes().to_vec()).unwrap()
}

fn approve(session: &str, id: &str) -> ApproverAction {
    ApproverAction::Approve {
        session_id: session.into(),
        approval_id: id.into(),
        phrase: None,
        for_session: false,
    }
}

struct World {
    fake: Fake,
    rig: Rig,
    b: BrokerRig,
    gate: Arc<ConfirmGate>,
    person: Arc<TestPresenter>,
}

impl World {
    async fn new(dir: &std::path::Path) -> Self {
        Self::with(dir, fast_confirm()).await
    }

    async fn with(dir: &std::path::Path, timings: ConfirmTimings) -> Self {
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
        b.broker.unlock(key()).await.unwrap();
        let gate = Arc::new(ConfirmGate::new(timings, Logger::none()));
        rig.seen.hook(gate.clone());
        b.seen.hook(gate.clone());
        Self {
            fake,
            rig,
            b,
            gate,
            person: Arc::new(TestPresenter::default()),
        }
    }

    /// Pide la confirmación en otra tarea (como el comando de Tauri, que espera).
    fn ask(
        &self,
        action: ApproverAction,
    ) -> tokio::task::JoinHandle<Result<(), dot_link::CommandError>> {
        let (gate, link, broker, person) = (
            self.gate.clone(),
            self.rig.link.clone(),
            self.b.broker.clone(),
            self.person.clone(),
        );
        tokio::spawn(async move {
            let confirmed = gate
                .request(&link, &broker, person.as_ref(), action)
                .await?;
            broker.resolve_confirmed(confirmed).await
        })
    }

    async fn confirm(
        &self,
        nonce: &str,
        phrase: Option<&str>,
    ) -> Result<(), dot_link::ConfirmFailure> {
        self.gate
            .confirm(
                &self.rig.link,
                &self.b.broker,
                nonce,
                phrase.map(str::to_string),
            )
            .await
    }

    async fn quit(self) {
        self.gate.invalidate(CancelReason::Closing);
        self.b.quit().await;
        self.rig.quit().await;
    }
}

async fn armed() {
    tokio::time::sleep(Duration::from_millis(80)).await;
}

#[tokio::test]
async fn un_webview_comprometido_no_resuelve_nada_sensible_sin_la_confirmacion() {
    let dir = tempfile::tempdir().unwrap();
    let w = World::new(dir.path()).await;
    w.fake
        .add_pending(PendingReq::of("approval", "apr_1", "ses_a"));
    w.fake
        .add_pending(PendingReq::of("question", "q_1", "ses_a"));
    w.fake.add_pending(PendingReq::of("plan", "p_1", "ses_a"));
    assert!(matches!(w.b.broker.status(), ApproverStatus::Ready { .. }));
    // Con el broker desbloqueado, pedir directamente lo sensible (lo que haría
    // un webview que se salta la interfaz) no envía nada.
    let sensitive = [
        approve("ses_a", "apr_1"),
        ApproverAction::Approve {
            session_id: "ses_a".into(),
            approval_id: "apr_1".into(),
            phrase: None,
            for_session: true,
        },
        ApproverAction::AnswerQuestions {
            session_id: "ses_a".into(),
            request_id: "q_1".into(),
            answers: Some(vec![QuestionAnswer {
                question: "¿Cuál?".into(),
                answer: "A".into(),
                option_id: Some("o1".into()),
            }]),
        },
        ApproverAction::DecidePlan {
            session_id: "ses_a".into(),
            request_id: "p_1".into(),
            approve: true,
        },
    ];
    for action in sensitive {
        let err = w.b.broker.resolve(action).await.unwrap_err();
        assert_eq!(err.kind, CommandErrorKind::NotConfirmed);
        assert_eq!(err.reason.as_deref(), Some(NEEDS_CONFIRMATION));
    }
    for method in ["approvals.resolve", "questions.answer", "plans.decide"] {
        assert_eq!(w.fake.count(method), 0, "{method}");
    }
    // Pedir la confirmación tampoco basta: sin que la persona confirme, nada sale.
    let asked = w.ask(approve("ses_a", "apr_1"));
    let nonce = w.person.nth(1).await;
    tokio::time::sleep(Duration::from_millis(400)).await;
    assert_eq!(w.fake.count("approvals.resolve"), 0);
    // Un nonce que no es el de la ventana no confirma (ni la cierra).
    let forged = w
        .confirm("0123456789abcdef0123456789abcdef", None)
        .await
        .unwrap_err();
    assert!(!forged.keep_open);
    assert!(w.gate.is_open());
    // Lo negativo sí sale directo: es lo que pasa cuando nadie contesta.
    w.b.broker
        .resolve(ApproverAction::DecidePlan {
            session_id: "ses_a".into(),
            request_id: "p_1".into(),
            approve: false,
        })
        .await
        .unwrap();
    assert_eq!(w.fake.count("plans.decide"), 1);
    w.gate.cancel(&nonce);
    let err = asked.await.unwrap().unwrap_err();
    assert_eq!(
        (err.kind, err.reason.as_deref()),
        (CommandErrorKind::NotConfirmed, Some("cancelled"))
    );
    assert_eq!(w.fake.count("approvals.resolve"), 0);
    assert_eq!(w.fake.pending_ids(), ["apr_1", "q_1"]);
    w.quit().await;
}

#[tokio::test]
async fn confirmar_envia_una_vez_con_la_sesion_y_lo_que_se_ensena_viene_del_daemon() {
    let dir = tempfile::tempdir().unwrap();
    let w = World::new(dir.path()).await;
    w.fake
        .add_pending(PendingReq::of("approval", "apr_1", "ses_a"));
    let asked = w.ask(approve("ses_a", "apr_1"));
    let nonce = w.person.nth(1).await;
    let view = w.gate.view(&nonce).unwrap();
    let approval = view.approval.as_ref().unwrap();
    assert_eq!(approval.description, "rm -rf build/ (apr_1)");
    assert_eq!(view.session.cwd.as_deref(), Some("/work/proj"));
    assert_eq!(view.session.id, "ses_a");
    // Demasiado pronto: la ventana sigue y no sale nada.
    let early = w.confirm(&nonce, None).await.unwrap_err();
    assert!(early.keep_open, "{early:?}");
    armed().await;
    w.confirm(&nonce, None).await.unwrap();
    asked.await.unwrap().unwrap();
    // Una sola vez: confirmar otra vez no hace nada.
    assert!(!w.confirm(&nonce, None).await.unwrap_err().keep_open);
    let sent: Vec<_> = w
        .fake
        .requests()
        .into_iter()
        .filter(|r| r["method"] == "approvals.resolve")
        .collect();
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0]["params"]["sessionId"], "ses_a");
    assert_eq!(sent[0]["params"]["decision"], "approve");
    assert!(w.person.closes() >= 1);
    w.quit().await;
}

#[tokio::test]
async fn caduca_si_el_broker_deja_de_estar_listo() {
    let dir = tempfile::tempdir().unwrap();
    let w = World::new(dir.path()).await;
    w.fake
        .add_pending(PendingReq::of("approval", "apr_1", "ses_a"));
    let asked = w.ask(approve("ses_a", "apr_1"));
    let nonce = w.person.nth(1).await;
    w.b.broker.lock();
    let err = asked.await.unwrap().unwrap_err();
    assert_eq!(err.reason.as_deref(), Some("locked"));
    armed().await;
    // La ventana ya no vale aunque la persona pulse.
    assert!(w.confirm(&nonce, None).await.is_err());
    assert_eq!(w.fake.count("approvals.resolve"), 0);
    w.quit().await;
}

#[tokio::test]
async fn una_confirmacion_de_otro_desbloqueo_no_vale() {
    let dir = tempfile::tempdir().unwrap();
    let w = World::new(dir.path()).await;
    w.fake
        .add_pending(PendingReq::of("approval", "apr_1", "ses_a"));
    // Confirmada, pero sin enviar todavía.
    let (asked, ()) = tokio::join!(
        w.gate.request(
            &w.rig.link,
            &w.b.broker,
            w.person.as_ref(),
            approve("ses_a", "apr_1")
        ),
        async {
            let nonce = w.person.nth(1).await;
            armed().await;
            w.confirm(&nonce, None).await.unwrap();
        }
    );
    let confirmed = asked.unwrap();
    w.b.broker.lock();
    until("bloqueado", || w.b.status() == "locked").await;
    tokio::time::sleep(Duration::from_millis(350)).await;
    w.b.broker.unlock(key()).await.unwrap();
    let err = w.b.broker.resolve_confirmed(confirmed).await.unwrap_err();
    assert_eq!(
        (err.kind, err.reason.as_deref()),
        (CommandErrorKind::NotConfirmed, Some("authority-changed"))
    );
    assert_eq!(w.fake.count("approvals.resolve"), 0);
    w.quit().await;
}

#[tokio::test]
async fn resuelta_en_la_terminal_con_la_ventana_abierta_no_se_vuelve_a_resolver() {
    let dir = tempfile::tempdir().unwrap();
    let w = World::new(dir.path()).await;
    // (a) El evento llega: la ventana se cierra sola.
    w.fake
        .add_pending(PendingReq::of("approval", "apr_1", "ses_a"));
    let asked = w.ask(approve("ses_a", "apr_1"));
    let _ = w.person.nth(1).await;
    w.fake.resolve_elsewhere("apr_1");
    w.fake.push_events(
        "ses_a",
        vec![state_event(
            "ses_a",
            2,
            "approval.resolved",
            json!({ "approvalId": "apr_1", "status": "approved", "resolvedBy": { "kind": "local", "at": 3 } }),
        )],
    );
    let err = asked.await.unwrap().unwrap_err();
    assert_eq!(err.reason.as_deref(), Some("resolved-elsewhere"));

    // (b) Sin evento todavía: al confirmar se pregunta otra vez al daemon.
    tokio::time::sleep(Duration::from_millis(150)).await;
    w.fake
        .add_pending(PendingReq::of("approval", "apr_2", "ses_a"));
    let asked = w.ask(approve("ses_a", "apr_2"));
    let nonce = w.person.nth(2).await;
    w.fake.resolve_elsewhere("apr_2");
    armed().await;
    let failed = w.confirm(&nonce, None).await.unwrap_err();
    assert!(!failed.keep_open);
    let err = asked.await.unwrap().unwrap_err();
    assert_eq!(err.reason.as_deref(), Some("resolved-elsewhere"));
    assert_eq!(w.fake.count("approvals.resolve"), 0);
    w.quit().await;
}

#[tokio::test]
async fn reiniciar_el_daemon_invalida_la_confirmacion_y_la_autoridad() {
    let dir = tempfile::tempdir().unwrap();
    let w = World::new(dir.path()).await;
    w.fake
        .add_pending(PendingReq::of("approval", "apr_1", "ses_a"));
    let asked = w.ask(approve("ses_a", "apr_1"));
    let nonce = w.person.nth(1).await;
    w.fake.stop(true);
    w.fake.start(TOKEN_B, 1);
    let err = asked.await.unwrap().unwrap_err();
    assert_eq!(err.kind, CommandErrorKind::NotConfirmed);
    assert!(
        matches!(
            err.reason.as_deref(),
            Some("locked" | "daemon-changed" | "disconnected")
        ),
        "{err:?}"
    );
    armed().await;
    assert!(w.confirm(&nonce, None).await.is_err());
    assert_eq!(w.fake.count("approvals.resolve"), 0);
    w.quit().await;
}

#[tokio::test]
async fn un_endpoint_sustituido_con_el_daemon_vivo_bloquea_la_autoridad() {
    let dir = tempfile::tempdir().unwrap();
    let w = World::new(dir.path()).await;
    w.fake
        .add_pending(PendingReq::of("approval", "apr_1", "ses_a"));
    let asked = w.ask(approve("ses_a", "apr_1"));
    let _ = w.person.nth(1).await;
    // Otro arranque publica su endpoint; las conexiones de antes siguen abiertas.
    w.fake.start(TOKEN_B, 1);
    until("bloqueado por cambio de daemon", || {
        w.b.broker.status()
            == ApproverStatus::Locked {
                reason: LockReason::DaemonChanged,
            }
    })
    .await;
    let err = asked.await.unwrap().unwrap_err();
    assert_eq!(err.reason.as_deref(), Some("daemon-changed"));
    assert_eq!(w.fake.count("approvals.resolve"), 0);
    w.quit().await;
}

#[tokio::test]
async fn sin_respuesta_del_daemon_el_resultado_es_desconocido_y_no_se_reenvia() {
    let dir = tempfile::tempdir().unwrap();
    let w = World::new(dir.path()).await;
    w.fake
        .add_pending(PendingReq::of("approval", "apr_1", "ses_a"));
    w.fake.set_silent("approvals.resolve");
    let asked = w.ask(approve("ses_a", "apr_1"));
    let nonce = w.person.nth(1).await;
    armed().await;
    w.confirm(&nonce, None).await.unwrap();
    let err = asked.await.unwrap().unwrap_err();
    assert_eq!(err.kind, CommandErrorKind::Unknown);
    tokio::time::sleep(Duration::from_millis(600)).await;
    assert_eq!(w.fake.count("approvals.resolve"), 1);
    assert!(!w.gate.is_open());
    w.quit().await;
}

#[tokio::test]
async fn caer_el_daemon_tras_enviar_es_desconocido() {
    let dir = tempfile::tempdir().unwrap();
    let w = World::new(dir.path()).await;
    w.fake
        .add_pending(PendingReq::of("approval", "apr_1", "ses_a"));
    w.fake.set_silent("approvals.resolve");
    let asked = w.ask(approve("ses_a", "apr_1"));
    let nonce = w.person.nth(1).await;
    armed().await;
    w.confirm(&nonce, None).await.unwrap();
    until("enviada", || w.fake.count("approvals.resolve") == 1).await;
    w.fake.kill_connections_with("approve");
    let err = asked.await.unwrap().unwrap_err();
    assert_eq!(err.kind, CommandErrorKind::Unknown);
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(w.fake.count("approvals.resolve"), 1);
    w.quit().await;
}

#[tokio::test]
async fn una_a_la_vez_y_sin_reabrir_en_bucle() {
    let dir = tempfile::tempdir().unwrap();
    let w = World::new(dir.path()).await;
    w.fake
        .add_pending(PendingReq::of("approval", "apr_1", "ses_a"));
    w.fake
        .add_pending(PendingReq::of("approval", "apr_2", "ses_a"));
    let first = w.ask(approve("ses_a", "apr_1"));
    let nonce = w.person.nth(1).await;
    // Otra petición no sustituye la ventana abierta.
    let err = w.ask(approve("ses_a", "apr_2")).await.unwrap().unwrap_err();
    assert_eq!(err.kind, CommandErrorKind::NotSent);
    assert_eq!(w.person.count(), 1);
    assert_eq!(w.gate.view(&nonce).unwrap().request_id, "apr_1");
    w.gate.cancel(&nonce);
    assert!(first.await.unwrap().is_err());
    // Recién cancelada, no se reabre en el acto.
    let err = w.ask(approve("ses_a", "apr_2")).await.unwrap().unwrap_err();
    assert_eq!(err.kind, CommandErrorKind::NotSent);
    assert_eq!(w.person.count(), 1);
    assert_eq!(w.fake.count("approvals.resolve"), 0);
    w.quit().await;
}

#[tokio::test]
async fn cerrar_dot_o_vencer_el_plazo_no_envia_nada() {
    let dir = tempfile::tempdir().unwrap();
    let mut timings = fast_confirm();
    timings.ttl = Duration::from_millis(300);
    let w = World::with(dir.path(), timings).await;
    w.fake
        .add_pending(PendingReq::of("approval", "apr_1", "ses_a"));
    let asked = w.ask(approve("ses_a", "apr_1"));
    let _ = w.person.nth(1).await;
    let err = asked.await.unwrap().unwrap_err();
    assert_eq!(err.reason.as_deref(), Some("expired"));

    tokio::time::sleep(Duration::from_millis(150)).await;
    let asked = w.ask(approve("ses_a", "apr_1"));
    let _ = w.person.nth(2).await;
    w.gate.invalidate(CancelReason::Closing);
    let err = asked.await.unwrap().unwrap_err();
    assert_eq!(err.reason.as_deref(), Some("closing"));
    assert_eq!(w.fake.count("approvals.resolve"), 0);
    assert_eq!(w.fake.pending_ids(), ["apr_1"]);
    w.quit().await;
}

#[tokio::test]
async fn si_la_sesion_desaparece_la_confirmacion_se_cae() {
    let dir = tempfile::tempdir().unwrap();
    let w = World::new(dir.path()).await;
    w.fake
        .add_pending(PendingReq::of("approval", "apr_1", "ses_b"));
    let asked = w.ask(approve("ses_b", "apr_1"));
    let _ = w.person.nth(1).await;
    w.fake.push_events(
        "ses_b",
        vec![state_event(
            "ses_b",
            2,
            "session.closed",
            json!({ "reason": "closed" }),
        )],
    );
    let err = asked.await.unwrap().unwrap_err();
    assert_eq!(err.reason.as_deref(), Some("session-gone"));
    w.quit().await;
}

#[tokio::test]
async fn dos_dot_compiten_y_solo_uno_resuelve() {
    let dir = tempfile::tempdir().unwrap();
    let w = World::new(dir.path()).await;
    // El segundo Dot: su propio enlace, su broker y su ventana.
    let rig2 = dot(dir.path(), None);
    until("conectado", || rig2.link.connection().is_connected()).await;
    let b2 = broker(dir.path(), fast_approver());
    b2.broker.observe_main(&rig2.link.connection());
    until("bloqueado", || b2.status() == "locked").await;
    b2.broker.unlock(key()).await.unwrap();
    let gate2 = Arc::new(ConfirmGate::new(fast_confirm(), Logger::none()));
    let person2 = Arc::new(TestPresenter::default());

    w.fake
        .add_pending(PendingReq::of("approval", "apr_1", "ses_a"));
    let one = w.ask(approve("ses_a", "apr_1"));
    let two = {
        let (gate, link, broker, person) = (
            gate2.clone(),
            rig2.link.clone(),
            b2.broker.clone(),
            person2.clone(),
        );
        tokio::spawn(async move {
            let confirmed = gate
                .request(&link, &broker, person.as_ref(), approve("ses_a", "apr_1"))
                .await?;
            broker.resolve_confirmed(confirmed).await
        })
    };
    let n1 = w.person.nth(1).await;
    let n2 = person2.nth(1).await;
    armed().await;
    let (c1, c2) = tokio::join!(
        w.confirm(&n1, None),
        gate2.confirm(&rig2.link, &b2.broker, &n2, None)
    );
    let outcomes = [
        c1.map_err(|_| ()).and(one.await.unwrap().map_err(|_| ())),
        c2.map_err(|_| ()).and(two.await.unwrap().map_err(|_| ())),
    ];
    assert_eq!(
        outcomes.iter().filter(|o| o.is_ok()).count(),
        1,
        "{outcomes:?}"
    );
    assert!(w.fake.pending_ids().is_empty());
    gate2.invalidate(CancelReason::Closing);
    b2.quit().await;
    rig2.quit().await;
    w.quit().await;
}

#[tokio::test]
async fn la_frase_se_teclea_en_la_ventana_y_allow_all_no_vale_con_politica() {
    let dir = tempfile::tempdir().unwrap();
    let w = World::new(dir.path()).await;
    let mut forced = PendingReq::of("approval", "apr_1", "ses_a");
    forced.forced = true;
    forced.confirm_phrase = Some("prod-db".into());
    w.fake.add_pending(forced);
    let err = w
        .ask(ApproverAction::Approve {
            session_id: "ses_a".into(),
            approval_id: "apr_1".into(),
            phrase: None,
            for_session: true,
        })
        .await
        .unwrap()
        .unwrap_err();
    assert_eq!(err.kind, CommandErrorKind::Invalid);
    assert_eq!(w.person.count(), 0);

    // Lo que tecleó el webview no cuenta: la frase se pide en la ventana.
    let asked = w.ask(ApproverAction::Approve {
        session_id: "ses_a".into(),
        approval_id: "apr_1".into(),
        phrase: Some("prod-db".into()),
        for_session: false,
    });
    let nonce = w.person.nth(1).await;
    let view = w.gate.view(&nonce).unwrap();
    assert_eq!(
        view.approval.as_ref().unwrap().confirm_phrase.as_deref(),
        Some("prod-db")
    );
    armed().await;
    assert!(w.confirm(&nonce, None).await.unwrap_err().keep_open);
    assert!(w.confirm(&nonce, Some("prod")).await.unwrap_err().keep_open);
    assert_eq!(w.fake.count("approvals.resolve"), 0);
    w.confirm(&nonce, Some("prod-db")).await.unwrap();
    asked.await.unwrap().unwrap();
    let sent = w
        .fake
        .requests()
        .into_iter()
        .find(|r| r["method"] == "approvals.resolve")
        .unwrap();
    assert_eq!(sent["params"]["phrase"], "prod-db");
    w.quit().await;
}

#[tokio::test]
async fn sin_ventana_no_hay_confirmacion() {
    let dir = tempfile::tempdir().unwrap();
    let w = World::new(dir.path()).await;
    w.fake
        .add_pending(PendingReq::of("approval", "apr_1", "ses_a"));
    w.person
        .broken
        .store(true, std::sync::atomic::Ordering::Relaxed);
    let err = w.ask(approve("ses_a", "apr_1")).await.unwrap().unwrap_err();
    assert_eq!(err.kind, CommandErrorKind::NotSent);
    assert!(!w.gate.is_open());
    assert_eq!(w.fake.count("approvals.resolve"), 0);
    w.quit().await;
}

#[tokio::test]
async fn pausa_y_aprobacion_no_se_mezclan() {
    // M5: resolver una aprobación de un run en pausa no lo reanuda, y pausar no
    // resuelve nada. Dot solo envía lo que la persona pide.
    let dir = tempfile::tempdir().unwrap();
    let w = World::new(dir.path()).await;
    w.fake
        .add_pending(PendingReq::of("approval", "apr_1", "ses_a"));
    w.rig
        .link
        .control(dot_link::ControlAction::Pause {
            session_id: "ses_a".into(),
            run_id: None,
        })
        .await
        .unwrap();
    w.rig
        .link
        .control(dot_link::ControlAction::Steer {
            session_id: "ses_a".into(),
            text: "y luego revisa los tests".into(),
        })
        .await
        .unwrap();
    let asked = w.ask(approve("ses_a", "apr_1"));
    let nonce = w.person.nth(1).await;
    armed().await;
    w.confirm(&nonce, None).await.unwrap();
    asked.await.unwrap().unwrap();
    let methods = w.fake.methods();
    assert_eq!(w.fake.count("runs.pause"), 1);
    assert_eq!(w.fake.count("runs.steer"), 1);
    assert_eq!(w.fake.count("approvals.resolve"), 1);
    // Ni reanudar ni cancelar por su cuenta.
    for method in ["runs.resume", "runs.cancel"] {
        assert!(!methods.iter().any(|m| m == method), "{method}");
    }
    w.quit().await;
}
