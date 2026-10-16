//! Identidad del par (Q2) y colas acotadas contra el daemon de pruebas: lo que
//! el sistema operativo verifica antes de que Dot envíe el token o la clave, y
//! que una avalancha de órdenes no haga crecer nada sin límite.

mod common;

use common::*;
use dot_link::link::{MAX_FOLLOWED_SESSIONS, MAX_IN_FLIGHT, MAX_QUEUED_COMMANDS};
use dot_link::{ApproverSecret, CommandErrorKind, ConnectionState, ControlAction};
use std::process::{Child, Command, Stdio};
use std::time::Duration;

/// Un proceso vivo que no es este (y que no atiende ningún canal).
fn other_process() -> Child {
    #[cfg(windows)]
    let mut cmd = {
        let mut c = Command::new("cmd");
        c.args(["/C", "ping -n 30 127.0.0.1 > NUL"]);
        c
    };
    #[cfg(unix)]
    let mut cmd = {
        let mut c = Command::new("sleep");
        c.arg("30");
        c
    };
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn a helper process")
}

#[tokio::test]
async fn el_sistema_confirma_que_atiende_el_daemon_del_endpoint() {
    let dir = tempfile::tempdir().unwrap();
    let fake = Fake::new(dir.path());
    fake.start(TOKEN_A, 1);
    let rig = dot(dir.path(), None);
    until("conectado", || rig.link.connection().is_connected()).await;
    // En Windows, Linux y macOS el sistema dice usuario y pid: nada que avisar.
    assert!(!rig.log().contains("peer identity"), "{}", rig.log());
    rig.quit().await;
}

#[tokio::test]
async fn si_el_canal_lo_atiende_otro_proceso_no_se_envia_el_token() {
    let dir = tempfile::tempdir().unwrap();
    let mut helper = other_process();
    let fake = Fake::new(dir.path());
    // El endpoint dice que el daemon es `helper`, pero el canal lo atiende este proceso.
    fake.set_endpoint_pid(Some(helper.id()));
    fake.start(TOKEN_A, 1);
    let rig = dot(dir.path(), None);
    until("rechazado", || {
        matches!(rig.link.connection(), ConnectionState::Error { .. })
    })
    .await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    // Se conectó, el sistema dijo quién era y no se envió nada: ni el saludo.
    assert!(fake.connections() >= 1);
    assert_eq!(fake.count("core.hello"), 0);
    assert!(rig.log().contains("peer identity"), "{}", rig.log());
    let ConnectionState::Error { message } = rig.link.connection() else {
        unreachable!()
    };
    assert!(message.contains("Nothing was sent"), "{message}");
    assert!(!rig.log().contains(TOKEN_A));
    rig.quit().await;
    let _ = helper.kill();
    let _ = helper.wait();
}

#[tokio::test]
async fn la_clave_no_se_envia_a_quien_no_es_el_daemon_del_endpoint() {
    let dir = tempfile::tempdir().unwrap();
    let mut helper = other_process();
    let fake = Fake::new(dir.path());
    fake.set_approver_key(Some(APPROVER_KEY));
    fake.start(TOKEN_A, 1);
    let rig = dot(dir.path(), None);
    until("conectado", || rig.link.connection().is_connected()).await;
    let b = broker(dir.path(), fast_approver());
    b.broker.observe_main(&rig.link.connection());
    until("bloqueado", || b.status() == "locked").await;
    // Alguien sustituye el endpoint: otro pid, el mismo canal (este proceso).
    fake.set_endpoint_pid(Some(helper.id()));
    fake.start(TOKEN_A, 1);
    let hellos_before = fake.count("core.hello");
    let err = b
        .broker
        .unlock(ApproverSecret::from_bytes(APPROVER_KEY.as_bytes().to_vec()).unwrap())
        .await
        .unwrap_err();
    assert_eq!(err.kind, CommandErrorKind::NotSent);
    assert!(err.message.contains("was not sent"), "{}", err.message);
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(fake.count("core.hello"), hellos_before);
    assert!(!fake
        .requests()
        .iter()
        .any(|r| r["params"].get("approverKey").is_some()));
    assert!(b.log().contains("approver: peer identity"), "{}", b.log());
    b.quit().await;
    rig.quit().await;
    let _ = helper.kill();
    let _ = helper.wait();
}

#[tokio::test]
async fn una_avalancha_de_ordenes_no_hace_crecer_nada() {
    let dir = tempfile::tempdir().unwrap();
    let fake = Fake::new(dir.path());
    fake.set_session(snapshot("ses_a", 1));
    fake.set_silent("runs.pause");
    fake.start(TOKEN_A, 1);
    let rig = dot(dir.path(), None);
    until("conectado", || rig.link.connection().is_connected()).await;
    let total = (MAX_QUEUED_COMMANDS + MAX_IN_FLIGHT) * 4;
    let mut tasks = Vec::new();
    for _ in 0..total {
        let link = rig.link.clone();
        tasks.push(tokio::spawn(async move {
            link.control(ControlAction::Pause {
                session_id: "ses_a".into(),
                run_id: None,
            })
            .await
        }));
    }
    let mut busy = 0;
    let mut unknown = 0;
    for task in tasks {
        match task.await.unwrap() {
            Err(e) if e.kind == CommandErrorKind::NotSent => busy += 1,
            Err(e) if e.kind == CommandErrorKind::Unknown => unknown += 1,
            other => panic!("{other:?}"),
        }
    }
    // Como mucho `MAX_IN_FLIGHT` llegaron al daemon; lo demás no salió.
    assert!(
        fake.count("runs.pause") <= MAX_IN_FLIGHT,
        "{}",
        fake.count("runs.pause")
    );
    assert_eq!(unknown, fake.count("runs.pause"));
    assert_eq!(busy + unknown, total);
    // Y el enlace sigue vivo y obedece a lo que no ocupa cola.
    assert!(rig.link.connection().is_connected());
    rig.link.focus(Some("ses_a".into()));
    rig.quit().await;
}

#[tokio::test]
async fn con_mas_de_64_sesiones_la_vista_dice_que_es_parcial() {
    let dir = tempfile::tempdir().unwrap();
    let fake = Fake::new(dir.path());
    let total = MAX_FOLLOWED_SESSIONS + 6;
    for i in 0..total {
        fake.set_session(snapshot(&format!("ses_{i:03}"), 1));
    }
    fake.start(TOKEN_A, 1);
    let rig = dot(dir.path(), None);
    let unfollowed = || {
        rig.seen.all().into_iter().rev().find_map(|e| match e {
            dot_link::DotEvent::Sessions {
                session_ids,
                unfollowed,
            } => Some((session_ids.len(), unfollowed)),
            _ => None,
        })
    };
    until("lista parcial", || {
        unfollowed() == Some((MAX_FOLLOWED_SESSIONS, 6))
    })
    .await;
    // Se cierra una seguida: entra una de las que esperaban.
    fake.remove_session("ses_000");
    fake.push_overview_events(vec![state_event(
        "ses_000",
        2,
        "session.closed",
        serde_json::json!({ "reason": "closed" }),
    )]);
    until("una más seguida", || {
        unfollowed() == Some((MAX_FOLLOWED_SESSIONS, 5))
    })
    .await;
    rig.quit().await;
}
