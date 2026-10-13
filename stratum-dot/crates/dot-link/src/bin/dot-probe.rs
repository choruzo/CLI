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
//!
//! Sirve para probar Dot contra un `stratumd` real sin automatizar una
//! ventana (`scripts/smoke-real.mjs`). Cerrar stdin lo termina, como cerrar Dot:
//! el daemon y sus sesiones siguen.
//!
//!   dot-probe [--endpoint-dir <dir>] [--log-dir <dir>] [--no-autostart]

use dot_link::discovery::default_endpoint_dir;
use dot_link::link::Timings;
use dot_link::{CallAction, CliLauncher, ControlAction, DotEvent, LinkConfig, Logger};
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

    let config = LinkConfig {
        endpoint_dir,
        client_version: env!("CARGO_PKG_VERSION").to_string(),
        autostart,
        launcher: Arc::new(CliLauncher::from_env()),
        logger: log_dir
            .map(|dir| Logger::to_dir(&dir))
            .unwrap_or_else(Logger::none),
        timings: Timings::default(),
    };
    let (link, task) = dot_link::spawn(config, |event: DotEvent| {
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
    link.shutdown();
    let _ = running.await;
}
