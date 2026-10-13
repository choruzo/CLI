//! El enlace nativo de Dot contra un daemon de pruebas sobre un pipe real:
//! descubrimiento, handshake, arranque del daemon, suscripciones, huecos,
//! reconexión, órdenes y lo que Dot **no** hace (apagar, reenviar, filtrar el token).

mod common;

use common::*;
use dot_link::{CommandErrorKind, ConnectionState, ControlAction, DaemonLauncher, DotEvent};
use serde_json::json;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

fn connected(rig: &Rig) -> bool {
    rig.link.connection().is_connected()
}

/// A. Descubre, saluda como `dot` con el rol mínimo y queda conectado.
#[tokio::test(flavor = "multi_thread")]
async fn descubre_saluda_y_conecta() {
    let dir = tempfile::tempdir().unwrap();
    let fake = Fake::new(dir.path());
    fake.set_session(snapshot("s1", 7));
    fake.start(TOKEN_A, 1);

    let rig = dot(dir.path(), None);
    until("conectado", || connected(&rig)).await;
    until("foto de s1", || !rig.seen.snapshots("s1").is_empty()).await;

    assert_eq!(rig.seen.states(), ["connecting", "connected"]);
    let hello = &fake.requests()[0];
    assert_eq!(hello["method"], "core.hello");
    assert_eq!(hello["params"]["protocol"], 1);
    assert_eq!(hello["params"]["client"]["kind"], "dot");
    // Mínima autoridad: nunca pide aprobar, ni manda una clave de aprobador.
    assert_eq!(hello["params"]["roles"], json!(["operator"]));
    assert!(hello["params"].get("approverKey").is_none());

    let ConnectionState::Connected {
        server_version,
        capabilities,
        protocol,
        ..
    } = rig.link.connection()
    else {
        panic!("connected")
    };
    assert_eq!(server_version, "0.9.0-test");
    assert_eq!(protocol, 1);
    assert_eq!(capabilities, ["observe", "control"]);
    assert_eq!(rig.seen.last_sessions(), Some(vec!["s1".to_string()]));
    assert_eq!(rig.link.session_count(), 1);
    // D. La foto llega tal cual, con su `seq`.
    assert_eq!(rig.seen.snapshots("s1")[0]["seq"], 7);
    rig.quit().await;
}

/// B. Sin daemon, Dot lo arranca (una vez) y conecta.
#[tokio::test(flavor = "multi_thread")]
async fn sin_daemon_lo_arranca_y_conecta() {
    let dir = tempfile::tempdir().unwrap();
    let fake = Fake::new(dir.path());
    let calls = Arc::new(AtomicU64::new(0));
    let launcher: Arc<dyn DaemonLauncher> = Arc::new(FakeLauncher {
        fake: fake.clone(),
        fail: false,
        calls: calls.clone(),
    });

    let rig = dot(dir.path(), Some(launcher));
    until("conectado", || connected(&rig)).await;
    assert_eq!(
        rig.seen.states(),
        ["daemon-starting", "connecting", "connected"]
    );
    assert_eq!(calls.load(Ordering::Relaxed), 1);
    rig.quit().await;
}

/// B'. Si no se puede arrancar, queda en `error` y se recupera solo cuando
/// aparece un daemon (AC-7). `retry` vuelve a intentar el arranque.
#[tokio::test(flavor = "multi_thread")]
async fn si_el_arranque_falla_queda_en_error_y_se_recupera_solo() {
    let dir = tempfile::tempdir().unwrap();
    let fake = Fake::new(dir.path());
    let calls = Arc::new(AtomicU64::new(0));
    let launcher: Arc<dyn DaemonLauncher> = Arc::new(FakeLauncher {
        fake: fake.clone(),
        fail: true,
        calls: calls.clone(),
    });

    let rig = dot(dir.path(), Some(launcher));
    until("error", || {
        matches!(rig.link.connection(), ConnectionState::Error { .. })
    })
    .await;
    let ConnectionState::Error { message } = rig.link.connection() else {
        panic!()
    };
    assert!(
        message.contains("Could not start the Stratum daemon"),
        "{message}"
    );

    // Sin que nadie lo pida no se vuelve a lanzar.
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(calls.load(Ordering::Relaxed), 1);
    rig.link.retry();
    until("segundo intento", || calls.load(Ordering::Relaxed) == 2).await;
    until("error otra vez", || {
        matches!(rig.link.connection(), ConnectionState::Error { .. })
    })
    .await;

    // Alguien arranca el daemon por fuera: Dot conecta sin intervención.
    fake.start(TOKEN_A, 1);
    until("conectado", || connected(&rig)).await;
    assert_eq!(calls.load(Ordering::Relaxed), 2);
    rig.quit().await;
}

/// E, F, G. Eventos en orden; un hueco pide foto; lo volátil perdido no importa.
#[tokio::test(flavor = "multi_thread")]
async fn eventos_huecos_y_fragmentos() {
    let dir = tempfile::tempdir().unwrap();
    let fake = Fake::new(dir.path());
    fake.set_session(snapshot("s1", 10));
    fake.start(TOKEN_A, 1);
    let rig = dot(dir.path(), None);
    until("foto", || rig.seen.snapshots("s1").len() == 1).await;

    // E. El siguiente evento se entrega; uno repetido, no.
    let e11 = state_event("s1", 11, "tool.started", json!({}));
    fake.push_events(
        "s1",
        vec![
            state_event("s1", 10, "warning", json!({})),
            e11.clone(),
            delta("s1", 11, "ho"),
        ],
    );
    until("evento 11", || rig.seen.events("s1").len() == 2).await;
    assert_eq!(rig.seen.events("s1"), vec![e11, delta("s1", 11, "ho")]);

    // F. Hueco: 13 sin 12. Se cambia la suscripción por otra que empieza con foto.
    let subscribes = fake.count("events.subscribe");
    fake.set_session(snapshot("s1", 14));
    fake.push_events("s1", vec![state_event("s1", 13, "warning", json!({}))]);
    until("foto nueva", || rig.seen.snapshots("s1").len() == 2).await;
    assert_eq!(rig.seen.snapshots("s1")[1]["seq"], 14);
    assert_eq!(fake.count("events.subscribe"), subscribes + 1);
    assert!(fake.count("events.unsubscribe") >= 1);
    // El evento del hueco no se entregó.
    assert!(rig.seen.events("s1").iter().all(|e| e["seq"] != 13));
    assert!(rig.log().contains("reason=seq-gap"));

    // Y sigue desde la foto: 14 repetido no, 15 sí.
    fake.push_events(
        "s1",
        vec![
            state_event("s1", 14, "warning", json!({})),
            state_event("s1", 15, "warning", json!({})),
        ],
    );
    until("evento 15", || {
        rig.seen.events("s1").iter().any(|e| e["seq"] == 15)
    })
    .await;
    assert!(rig.seen.events("s1").iter().all(|e| e["seq"] != 14));
    rig.quit().await;
}

/// Una foto no pedida (suscripción desincronizada en el servidor) sustituye.
#[tokio::test(flavor = "multi_thread")]
async fn una_foto_no_pedida_sustituye() {
    let dir = tempfile::tempdir().unwrap();
    let fake = Fake::new(dir.path());
    fake.set_session(snapshot("s1", 3));
    fake.start(TOKEN_A, 1);
    let rig = dot(dir.path(), None);
    until("foto", || rig.seen.snapshots("s1").len() == 1).await;

    fake.push_snapshot("s1", snapshot("s1", 40));
    until("segunda foto", || rig.seen.snapshots("s1").len() == 2).await;
    fake.push_events(
        "s1",
        vec![
            state_event("s1", 40, "warning", json!({})),
            state_event("s1", 41, "warning", json!({})),
        ],
    );
    until("evento 41", || !rig.seen.events("s1").is_empty()).await;
    assert_eq!(rig.seen.events("s1").len(), 1);
    assert_eq!(rig.seen.events("s1")[0]["seq"], 41);
    rig.quit().await;
}

/// Solo la sesión enfocada pide los fragmentos de texto.
#[tokio::test(flavor = "multi_thread")]
async fn solo_la_sesion_enfocada_recibe_lo_volatil() {
    let dir = tempfile::tempdir().unwrap();
    let fake = Fake::new(dir.path());
    fake.set_session(snapshot("s1", 1));
    fake.set_session(snapshot("s2", 1));
    fake.start(TOKEN_A, 1);
    let rig = dot(dir.path(), None);
    until("fotos", || {
        rig.seen.snapshots("s1").len() == 1 && rig.seen.snapshots("s2").len() == 1
    })
    .await;

    let scopes = |fake: &Fake| -> Vec<(String, bool)> {
        fake.requests()
            .iter()
            .filter(|r| {
                r["method"] == "events.subscribe" && r["params"]["scope"]["kind"] == "session"
            })
            .map(|r| {
                let scope = &r["params"]["scope"];
                // Dot nunca pide reenvío: siempre foto.
                assert!(scope.get("sinceSeq").is_none());
                (
                    scope["sessionId"].as_str().unwrap().to_string(),
                    scope["volatile"].as_bool().unwrap(),
                )
            })
            .collect()
    };
    assert_eq!(
        scopes(&fake),
        [("s1".to_string(), false), ("s2".to_string(), false)]
    );

    rig.link.focus(Some("s2".into()));
    until("s2 con volátil", || {
        scopes(&fake).last() == Some(&("s2".to_string(), true))
    })
    .await;
    until("foto nueva de s2", || rig.seen.snapshots("s2").len() == 2).await;

    rig.link.focus(Some("s1".into()));
    until("s1 con volátil", || {
        scopes(&fake).last() == Some(&("s1".to_string(), true))
    })
    .await;
    let all = scopes(&fake);
    assert_eq!(all[all.len() - 2], ("s2".to_string(), false));
    rig.quit().await;
}

/// Altas y bajas de sesiones por la suscripción de conjunto.
#[tokio::test(flavor = "multi_thread")]
async fn sesiones_que_aparecen_y_desaparecen() {
    let dir = tempfile::tempdir().unwrap();
    let fake = Fake::new(dir.path());
    fake.set_session(snapshot("s1", 1));
    fake.start(TOKEN_A, 1);
    let rig = dot(dir.path(), None);
    until("s1", || rig.seen.last_sessions() == Some(vec!["s1".into()])).await;

    fake.set_session(snapshot("s2", 1));
    fake.push_overview_events(vec![state_event("s2", 1, "session.opened", json!({}))]);
    until("s1 y s2", || {
        rig.seen.last_sessions() == Some(vec!["s1".into(), "s2".into()])
    })
    .await;
    until("foto de s2", || rig.seen.snapshots("s2").len() == 1).await;

    fake.remove_session("s1");
    fake.push_overview_events(vec![state_event(
        "s1",
        2,
        "session.closed",
        json!({ "reason": "closed" }),
    )]);
    until("solo s2", || {
        rig.seen.last_sessions() == Some(vec!["s2".into()])
    })
    .await;
    assert_eq!(rig.link.session_count(), 1);
    rig.quit().await;
}

/// C. El daemon muere: Dot sigue abierta, reconecta sola y no lo arranca.
#[tokio::test(flavor = "multi_thread")]
async fn el_daemon_muere_y_vuelve() {
    let dir = tempfile::tempdir().unwrap();
    let fake = Fake::new(dir.path());
    fake.set_session(snapshot("s1", 5));
    let calls = Arc::new(AtomicU64::new(0));
    let launcher: Arc<dyn DaemonLauncher> = Arc::new(FakeLauncher {
        fake: fake.clone(),
        fail: false,
        calls: calls.clone(),
    });
    fake.start(TOKEN_A, 1);
    let rig = dot(dir.path(), Some(launcher));
    until("foto", || rig.seen.snapshots("s1").len() == 1).await;

    // `kill -9`: el endpoint se queda, rancio.
    fake.stop(false);
    until("reconectando", || {
        matches!(rig.link.connection(), ConnectionState::Reconnecting { .. })
    })
    .await;
    until("varios intentos", || matches!(rig.link.connection(), ConnectionState::Reconnecting { attempt } if attempt >= 3)).await;
    // No se borró nada de lo que la interfaz tenía: ni una lista vacía ni fotos nuevas.
    assert_eq!(rig.seen.last_sessions(), Some(vec!["s1".to_string()]));
    // Sin conexión, una orden no se encola: falla en el acto.
    let err = rig
        .link
        .control(ControlAction::Pause {
            session_id: "s1".into(),
            run_id: None,
        })
        .await
        .unwrap_err();
    assert_eq!(err.kind, CommandErrorKind::NotSent);

    // Vuelve otro arranque: canal y token nuevos, y la sesión más adelante.
    fake.set_session(snapshot("s1", 9));
    fake.start(TOKEN_B, 1);
    until("conectado otra vez", || connected(&rig)).await;
    until("foto tras reconectar", || {
        rig.seen.snapshots("s1").len() == 2
    })
    .await;
    assert_eq!(rig.seen.snapshots("s1")[1]["seq"], 9);
    assert_eq!(fake.connections(), 2);
    // Reconectar nunca arranca el daemon: si alguien lo paró, no se le lleva la contraria.
    assert_eq!(calls.load(Ordering::Relaxed), 0);
    let states = rig.seen.states();
    assert_eq!(states.first().map(String::as_str), Some("connecting"));
    assert_eq!(states.last().map(String::as_str), Some("connected"));
    assert!(!states.contains(&"error".to_string()), "{states:?}");
    rig.quit().await;
}

/// I, J. Las órdenes viajan por el protocolo y devuelven lo que diga el
/// anfitrión; por sí solas no producen ningún cambio de estado en la interfaz.
#[tokio::test(flavor = "multi_thread")]
async fn las_ordenes_viajan_y_no_cambian_el_estado_local() {
    let dir = tempfile::tempdir().unwrap();
    let fake = Fake::new(dir.path());
    fake.set_session(snapshot("s1", 5));
    fake.start(TOKEN_A, 1);
    let rig = dot(dir.path(), None);
    until("foto", || rig.seen.snapshots("s1").len() == 1).await;
    rig.seen.clear();

    let pause = ControlAction::Pause {
        session_id: "s1".into(),
        run_id: Some("run_1".into()),
    };
    assert_eq!(rig.link.control(pause).await.unwrap(), "requested");
    let steer = ControlAction::Steer {
        session_id: "s1".into(),
        text: "prueba otra cosa".into(),
    };
    assert_eq!(rig.link.control(steer).await.unwrap(), "accepted");
    let resume = ControlAction::Resume {
        session_id: "s1".into(),
        run_id: None,
    };
    assert_eq!(rig.link.control(resume).await.unwrap(), "resumed");
    let cancel = ControlAction::Cancel {
        session_id: "s1".into(),
        run_id: None,
    };
    assert_eq!(rig.link.control(cancel).await.unwrap(), "cancelled");

    let sent: Vec<_> = fake
        .requests()
        .into_iter()
        .filter(|r| r["method"].as_str().unwrap().starts_with("runs."))
        .collect();
    assert_eq!(sent[0]["method"], "runs.pause");
    assert_eq!(
        sent[0]["params"],
        json!({ "sessionId": "s1", "runId": "run_1" })
    );
    assert_eq!(
        sent[1]["params"],
        json!({ "sessionId": "s1", "text": "prueba otra cosa" })
    );
    assert_eq!(sent[2]["method"], "runs.resume");
    assert_eq!(sent[3]["method"], "runs.cancel");
    // Ninguna foto ni evento inventado: el estado solo cambia cuando lo publica el anfitrión.
    assert!(rig.seen.all().is_empty(), "{:?}", rig.seen.all());

    // El error del anfitrión llega con su código y su motivo.
    let err = rig
        .link
        .control(ControlAction::Steer {
            session_id: "detached".into(),
            text: "x".into(),
        })
        .await
        .unwrap_err();
    assert_eq!(err.kind, CommandErrorKind::Rejected);
    assert_eq!(err.code.as_deref(), Some("UNAVAILABLE"));
    assert_eq!(err.reason.as_deref(), Some("host-unavailable"));
    rig.quit().await;
}

/// Una orden enviada y sin respuesta tiene resultado desconocido y no se reenvía.
#[tokio::test(flavor = "multi_thread")]
async fn resultado_desconocido_y_sin_reenvio() {
    let dir = tempfile::tempdir().unwrap();
    let fake = Fake::new(dir.path());
    fake.set_session(snapshot("s1", 5));
    fake.set_silent("runs.cancel");
    fake.start(TOKEN_A, 1);
    let rig = dot(dir.path(), None);
    until("foto", || rig.seen.snapshots("s1").len() == 1).await;

    // Plazo vencido.
    let err = rig
        .link
        .control(ControlAction::Cancel {
            session_id: "s1".into(),
            run_id: None,
        })
        .await
        .unwrap_err();
    assert_eq!(err.kind, CommandErrorKind::Unknown);

    // Conexión caída con la orden en vuelo.
    let link = rig.link.clone();
    let flying = tokio::spawn(async move {
        link.control(ControlAction::Cancel {
            session_id: "s1".into(),
            run_id: None,
        })
        .await
    });
    until("enviada", || fake.count("runs.cancel") == 2).await;
    fake.stop(false);
    assert_eq!(
        flying.await.unwrap().unwrap_err().kind,
        CommandErrorKind::Unknown
    );

    fake.start(TOKEN_B, 1);
    until("conectado otra vez", || connected(&rig)).await;
    until("foto tras reconectar", || {
        rig.seen.snapshots("s1").len() == 2
    })
    .await;
    // Al reconectar solo se restablecen las suscripciones.
    assert_eq!(fake.count("runs.cancel"), 2);
    rig.quit().await;
}

/// Protocolo incompatible en el endpoint: ni se conecta, ni se insiste.
#[tokio::test(flavor = "multi_thread")]
async fn endpoint_incompatible_no_conecta() {
    let dir = tempfile::tempdir().unwrap();
    let fake = Fake::new(dir.path());
    fake.start(TOKEN_A, 2);
    let rig = dot(dir.path(), None);
    until("incompatible", || {
        matches!(rig.link.connection(), ConnectionState::Incompatible { .. })
    })
    .await;
    assert_eq!(
        rig.link.connection(),
        ConnectionState::Incompatible {
            client_protocol: 1,
            daemon_protocol: Some(2),
            daemon_version: Some("0.9.0-test".into())
        }
    );
    tokio::time::sleep(Duration::from_millis(250)).await;
    assert_eq!(fake.connections(), 0);

    // Llega un daemon compatible: Dot sale sola del estado.
    fake.stop(true);
    fake.start(TOKEN_B, 1);
    until("conectado", || connected(&rig)).await;
    rig.quit().await;
}

/// El daemon rechaza la versión en el handshake: un intento, no un bucle.
#[tokio::test(flavor = "multi_thread")]
async fn mismatch_en_el_handshake_no_entra_en_bucle() {
    for hello in [Hello::Mismatch(3), Hello::WrongVersion(3)] {
        let dir = tempfile::tempdir().unwrap();
        let fake = Fake::new(dir.path());
        fake.set_hello(hello);
        fake.start(TOKEN_A, 1);
        let rig = dot(dir.path(), None);
        until("incompatible", || {
            matches!(rig.link.connection(), ConnectionState::Incompatible { .. })
        })
        .await;
        let ConnectionState::Incompatible {
            daemon_protocol, ..
        } = rig.link.connection()
        else {
            panic!()
        };
        assert_eq!(daemon_protocol, Some(3));
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert_eq!(fake.connections(), 1);
        // Tras el handshake fallido no se envió ningún otro método.
        assert_eq!(fake.methods(), ["core.hello"]);

        // `retry` sí lo vuelve a intentar, una vez.
        rig.link.retry();
        until("segundo intento", || fake.connections() == 2).await;
        until("incompatible", || {
            matches!(rig.link.connection(), ConnectionState::Incompatible { .. })
        })
        .await;
        rig.quit().await;
    }
}

/// Un token que no vale: error, sin insistir contra el mismo daemon.
#[tokio::test(flavor = "multi_thread")]
async fn token_rechazado_es_un_error_sin_bucle() {
    let dir = tempfile::tempdir().unwrap();
    let fake = Fake::new(dir.path());
    fake.set_hello(Hello::Unauthorized);
    fake.start(TOKEN_A, 1);
    let rig = dot(dir.path(), None);
    until("error", || {
        matches!(rig.link.connection(), ConnectionState::Error { .. })
    })
    .await;
    tokio::time::sleep(Duration::from_millis(250)).await;
    assert_eq!(fake.connections(), 1);
    let ConnectionState::Error { message } = rig.link.connection() else {
        panic!()
    };
    assert!(message.contains("UNAUTHORIZED"), "{message}");
    rig.quit().await;
}

/// La interfaz (re)carga: recibe el estado y una foto de cada sesión.
#[tokio::test(flavor = "multi_thread")]
async fn attach_repite_el_estado_y_las_fotos() {
    let dir = tempfile::tempdir().unwrap();
    let fake = Fake::new(dir.path());
    fake.set_session(snapshot("s1", 5));
    fake.start(TOKEN_A, 1);
    let rig = dot(dir.path(), None);
    until("foto", || rig.seen.snapshots("s1").len() == 1).await;
    rig.seen.clear();

    rig.link.attach();
    until("foto otra vez", || rig.seen.snapshots("s1").len() == 1).await;
    assert_eq!(rig.seen.states(), ["connected"]);
    assert_eq!(rig.seen.last_sessions(), Some(vec!["s1".to_string()]));
    assert_eq!(fake.connections(), 1);
    rig.quit().await;
}

/// K. Cerrar Dot no apaga el daemon, no cancela runs y no cierra sesiones.
#[tokio::test(flavor = "multi_thread")]
async fn cerrar_dot_no_toca_el_daemon() {
    let dir = tempfile::tempdir().unwrap();
    let fake = Fake::new(dir.path());
    fake.set_session(snapshot("s1", 5));
    fake.start(TOKEN_A, 1);
    let rig = dot(dir.path(), None);
    until("foto", || rig.seen.snapshots("s1").len() == 1).await;
    rig.link.focus(Some("s1".into()));
    until("foto con foco", || rig.seen.snapshots("s1").len() == 2).await;

    let log_dir = rig.log_dir.clone();
    rig.quit().await;
    until("conexión cerrada", || fake.live_connections() == 0).await;

    let allowed = ["core.hello", "events.subscribe", "events.unsubscribe"];
    for method in fake.methods() {
        assert!(
            allowed.contains(&method.as_str()),
            "Dot envió {method} al cerrarse"
        );
    }
    assert_eq!(fake.count("core.shutdown"), 0);
    // El endpoint sigue donde estaba: Dot no lo toca.
    assert!(dir.path().join("endpoint.json").exists());
    let log = std::fs::read_to_string(log_dir.join("dot.log")).unwrap();
    assert!(log.contains("the daemon keeps running"), "{log}");
}

/// L. El token no sale del enlace: ni en lo que recibe la interfaz ni en el log.
#[tokio::test(flavor = "multi_thread")]
async fn el_token_no_llega_a_la_interfaz_ni_al_log() {
    let dir = tempfile::tempdir().unwrap();
    let fake = Fake::new(dir.path());
    fake.set_session(snapshot("s1", 5));
    fake.start(TOKEN_A, 1);
    let rig = dot(dir.path(), None);
    until("foto", || rig.seen.snapshots("s1").len() == 1).await;
    let _ = rig
        .link
        .control(ControlAction::Pause {
            session_id: "s1".into(),
            run_id: None,
        })
        .await;
    fake.stop(false);
    until("reconectando", || {
        matches!(rig.link.connection(), ConnectionState::Reconnecting { .. })
    })
    .await;
    fake.start(TOKEN_B, 1);
    until("conectado", || connected(&rig)).await;
    rig.link.attach();
    until("foto tras attach", || rig.seen.snapshots("s1").len() >= 2).await;

    let pipe = fake.requests().len(); // el daemon sí lo recibió (en `core.hello`)
    assert!(pipe > 0);
    let to_ui: String = rig
        .seen
        .all()
        .iter()
        .map(|e: &DotEvent| format!("{}\n{e:?}\n", serde_json::to_string(e).unwrap()))
        .collect();
    let state = format!("{:?}", rig.link.connection());
    let log = rig.log();
    assert!(!log.is_empty());
    for secret in [TOKEN_A, TOKEN_B, "dot-link-test-", ".sock", "endpoint.json"] {
        assert!(!to_ui.contains(secret), "la interfaz recibió {secret}");
        assert!(!state.contains(secret));
        if secret != "endpoint.json" {
            assert!(!log.contains(secret), "el log contiene {secret}");
        }
    }
    rig.quit().await;
}
