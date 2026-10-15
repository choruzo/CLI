//! `dot-probe`: el cliente nativo de Stratum Dot sin ventana. Mismo enlace que
//! usa la app (`dot_link::spawn`), con la interfaz cambiada por texto:
//!
//!  - stdout: cada [`DotEvent`] como una línea JSON, más el resultado de cada orden;
//!  - stdin: una orden por línea JSON
//!    (`{"cmd":"pause","sessionId":"…","runId":"…","id":1}`; `resume`, `cancel`,
//!    `steer` con `text`, `focus`, `resync`, `attach`, `retry`, `quit`), y las
//!    llamadas de chat: `open` (`cwd`, `agent`, `provider`, `model`), `send`
//!    (`sessionId`, `input`), `agents` (`cwd`) y `models`, cuyo `result` se
//!    imprime tal cual.
//!  - y las del broker de aprobador, como las pide la app: `unlock` (`key`),
//!    `lock`, `approve` (`sessionId`, `approvalId`, `phrase?`, `forSession?`),
//!    `deny`, `answer` (`requestId`, `answers` o `null`) y `plan` (`requestId`,
//!    `approve`). **Solo para pruebas**: la app nunca recibe la clave por aquí
//!    —en la app la teclea la persona en la ventana de desbloqueo— y este
//!    binario no se distribuye con ella.
//!
//! Sirve para probar Dot contra un `stratumd` real sin automatizar una
//! ventana (`scripts/smoke-real.mjs`). Cerrar stdin lo termina, como cerrar Dot:
//! el daemon y sus sesiones siguen.
//!
//!   dot-probe [--endpoint-dir <dir>] [--log-dir <dir>] [--no-autostart]

use dot_link::approver::ApproverTimings;
use dot_link::discovery::default_endpoint_dir;
use dot_link::link::Timings;
use dot_link::{
    ApproverAction, ApproverConfig, ApproverSecret, CallAction, CliLauncher, ControlAction,
    DotEvent, LinkConfig, Logger, QuestionAnswer,
};
use serde_json::{json, Value};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, BufReader};

fn print(value: &Value) {
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{value}");
    let _ = out.flush();
}

#[tokio::main]
async fn main() {
    let mut endpoint_dir: Option<PathBuf> = None;
    let mut log_dir: Option<PathBuf> = None;
    let mut autostart = true;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--endpoint-dir" => endpoint_dir = args.next().map(PathBuf::from),
            "--log-dir" => log_dir = args.next().map(PathBuf::from),
            "--no-autostart" => autostart = false,
            other => {
                eprintln!("dot-probe: unknown argument {other}");
                std::process::exit(2);
            }
        }
    }
    let Some(endpoint_dir) = endpoint_dir.or_else(default_endpoint_dir) else {
        eprintln!("dot-probe: cannot resolve the home directory");
        std::process::exit(2);
    };

    let logger = log_dir
        .map(|dir| Logger::to_dir(&dir))
        .unwrap_or_else(Logger::none);
    let (broker, broker_task) = dot_link::spawn_broker(
        ApproverConfig {
            endpoint_dir: endpoint_dir.clone(),
            client_version: env!("CARGO_PKG_VERSION").to_string(),
            logger: logger.clone(),
            timings: ApproverTimings::default(),
        },
        |event: DotEvent| print(&serde_json::to_value(&event).unwrap_or(Value::Null)),
    );
    let broker_running = tokio::spawn(broker_task);
    let config = LinkConfig {
        endpoint_dir,
        client_version: env!("CARGO_PKG_VERSION").to_string(),
        autostart,
        launcher: Arc::new(CliLauncher::from_env()),
        logger,
        timings: Timings::default(),
    };
    let observer = broker.clone();
    let (link, task) = dot_link::spawn(config, move |event: DotEvent| {
        // Como la app: el broker sabe por la conexión principal si hay a quién acreditarse.
        if let DotEvent::Connection { state } = &event {
            observer.observe_main(state);
        }
        print(&serde_json::to_value(&event).unwrap_or(Value::Null));
    });
    let running = tokio::spawn(task);
    link.attach();

    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let Ok(msg) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let text = |key: &str| msg.get(key).and_then(Value::as_str).map(str::to_string);
        let session_id = text("sessionId").unwrap_or_default();
        let cmd = text("cmd").unwrap_or_default();
        let call = match cmd.as_str() {
            "open" => Some(CallAction::OpenSession {
                cwd: text("cwd"),
                agent: text("agent"),
                provider: text("provider"),
                model: text("model"),
            }),
            "send" => Some(CallAction::StartRun {
                session_id: session_id.clone(),
                input: text("input").unwrap_or_default(),
            }),
            "agents" => Some(CallAction::ListAgents { cwd: text("cwd") }),
            "models" => Some(CallAction::ListModels),
            _ => None,
        };
        let approver = match cmd.as_str() {
            "approve" => Some(ApproverAction::Approve {
                session_id: session_id.clone(),
                approval_id: text("approvalId").unwrap_or_default(),
                phrase: text("phrase"),
                for_session: msg
                    .get("forSession")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            }),
            "deny" => Some(ApproverAction::Deny {
                session_id: session_id.clone(),
                approval_id: text("approvalId").unwrap_or_default(),
            }),
            "answer" => Some(ApproverAction::AnswerQuestions {
                session_id: session_id.clone(),
                request_id: text("requestId").unwrap_or_default(),
                answers: msg.get("answers").filter(|a| !a.is_null()).map(|a| {
                    serde_json::from_value::<Vec<QuestionAnswer>>(a.clone()).unwrap_or_default()
                }),
            }),
            "plan" => Some(ApproverAction::DecidePlan {
                session_id: session_id.clone(),
                request_id: text("requestId").unwrap_or_default(),
                approve: msg.get("approve").and_then(Value::as_bool).unwrap_or(false),
            }),
            _ => None,
        };
        if cmd == "unlock" || approver.is_some() {
            let broker = broker.clone();
            let id = msg.get("id").cloned().unwrap_or(Value::Null);
            let secret = if cmd == "unlock" {
                ApproverSecret::from_bytes(text("key").unwrap_or_default().into_bytes()).ok()
            } else {
                None
            };
            tokio::spawn(async move {
                let outcome = match (approver, secret) {
                    (Some(action), _) => broker.resolve(action).await,
                    (None, Some(secret)) => broker.unlock(secret).await,
                    (None, None) => Err(dot_link::CommandError::new(
                        dot_link::CommandErrorKind::Invalid,
                        "No key.",
                    )),
                };
                match outcome {
                    Ok(()) => print(&json!({ "type": "result", "cmd": cmd, "id": id, "ok": true })),
                    Err(error) => print(
                        &json!({ "type": "result", "cmd": cmd, "id": id, "ok": false, "error": error }),
                    ),
                }
            });
            continue;
        }
        if cmd == "lock" {
            broker.lock();
            continue;
        }
        if let Some(call) = call {
            let link = link.clone();
            let id = msg.get("id").cloned().unwrap_or(Value::Null);
            tokio::spawn(async move {
                match link.call(call).await {
                    Ok(result) => print(
                        &json!({ "type": "result", "cmd": cmd, "id": id, "ok": true, "result": result }),
                    ),
                    Err(error) => print(
                        &json!({ "type": "result", "cmd": cmd, "id": id, "ok": false, "error": error }),
                    ),
                }
            });
            continue;
        }
        let action = match cmd.as_str() {
            "quit" => break,
            "attach" => {
                link.attach();
                broker.attach();
                continue;
            }
            "retry" => {
                link.retry();
                continue;
            }
            "focus" => {
                link.focus(text("sessionId"));
                continue;
            }
            "resync" => {
                link.resync_session(session_id);
                continue;
            }
            "pause" => ControlAction::Pause {
                session_id,
                run_id: text("runId"),
            },
            "resume" => ControlAction::Resume {
                session_id,
                run_id: text("runId"),
            },
            "cancel" => ControlAction::Cancel {
                session_id,
                run_id: text("runId"),
            },
            "steer" => ControlAction::Steer {
                session_id,
                text: text("text").unwrap_or_default(),
            },
            _ => continue,
        };
        let link = link.clone();
        let id = msg.get("id").cloned().unwrap_or(Value::Null);
        tokio::spawn(async move {
            match link.control(action).await {
                Ok(status) => print(
                    &json!({ "type": "result", "cmd": cmd, "id": id, "ok": true, "status": status }),
                ),
                Err(error) => print(
                    &json!({ "type": "result", "cmd": cmd, "id": id, "ok": false, "error": error }),
                ),
            }
        });
    }
    broker.shutdown();
    link.shutdown();
    let _ = broker_running.await;
    let _ = running.await;
}
