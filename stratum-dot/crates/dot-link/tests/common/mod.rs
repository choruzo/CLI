//! Daemon de pruebas: habla el Stratum Protocol de verdad sobre un pipe real
//! (named pipe / unix socket) y publica su `endpoint.json`, pero **no es un
//! daemon**: no aloja sesiones. Lo que contesta lo decide cada test.
#![allow(dead_code)]

use dot_link::link::Timings;
use dot_link::{DaemonLauncher, DotEvent, LinkConfig, LinkHandle, Logger, NoLauncher};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

pub const TOKEN_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa0001";
pub const TOKEN_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb0002";

static PIPE_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, PartialEq)]
pub enum Hello {
    Ok,
    /// Error `PROTOCOL_MISMATCH` con esa versión del servidor.
    Mismatch(u64),
    /// Acepta, pero dice hablar esa versión.
    WrongVersion(u64),
    Unauthorized,
}

enum Scope {
    Overview,
    Session(String),
}

struct ConnEntry {
    id: u64,
    out: mpsc::UnboundedSender<String>,
    subs: Vec<(String, Scope)>,
}

struct State {
    token: String,
    hello: Hello,
    /// Fotos de las sesiones vivas, en orden.
    sessions: Vec<(String, Value)>,
    conns: Vec<ConnEntry>,
    /// Todas las peticiones recibidas, de todas las conexiones y arranques.
    requests: Vec<Value>,
    connections: usize,
    /// Métodos que no se contestan (para probar el resultado desconocido).
    silent: HashSet<String>,
    next_sub: u64,
    next_conn: u64,
    tasks: Vec<JoinHandle<()>>,
}

struct Inner {
    dir: PathBuf,
    state: Mutex<State>,
}

#[derive(Clone)]
pub struct Fake {
    inner: Arc<Inner>,
}

pub fn session_dto(id: &str, seq: u64, state: &str, host_kind: &str, connected: bool) -> Value {
    json!({
        "id": id, "title": "tarea larga", "cwd": "/work/proj",
        "host": { "kind": host_kind, "client": "cli", "connected": connected },
        "state": state, "agent": "general", "provider": "local", "model": "mock-model",
        "sessionProfile": "full", "readOnly": false, "activeTarget": "local",
        "context": { "used": 100, "max": 1000, "pct": 10, "estimated": false },
        "tokens": { "total": null, "status": "unavailable" },
        "currentRunId": "run_1", "seq": seq, "createdAt": 1, "updatedAt": 2
    })
}

pub fn run_dto(session_id: &str, status: &str) -> Value {
    json!({
        "id": "run_1", "sessionId": session_id, "kind": "run", "input": "tarea larga", "mode": "normal",
        "status": status, "startedAt": 1,
        "counters": { "llmCalls": 0, "toolCalls": 0, "toolErrors": 0, "blocked": 0,
                      "memoryReads": 0, "memoryWrites": 0, "subagents": 0, "jobs": 0 }
    })
}

pub fn snapshot(id: &str, seq: u64) -> Value {
    json!({
        "session": session_dto(id, seq, "running", "peer", true),
        "seq": seq, "run": run_dto(id, "running"),
        "partial": { "text": "", "reasoning": "" },
        "toolCalls": [], "subagents": [], "todos": [], "jobs": [],
        "approvals": [], "questions": [], "plans": [],
        "messages": [], "messagesTruncated": false
    })
}

pub fn state_event(id: &str, seq: u64, kind: &str, data: Value) -> Value {
    json!({ "type": kind, "sessionId": id, "runId": "run_1", "at": 10 + seq, "seq": seq, "data": data })
}

pub fn delta(id: &str, after: u64, text: &str) -> Value {
    json!({ "type": "message.delta", "sessionId": id, "at": 5, "after": after, "data": { "text": text } })
}

fn line(value: Value) -> String {
    let mut text = value.to_string();
    text.push('\n');
    text
}

impl Fake {
    /// Un daemon parado, con su carpeta de endpoint (vacía).
    pub fn new(dir: &Path) -> Self {
        Self {
            inner: Arc::new(Inner {
                dir: dir.to_path_buf(),
                state: Mutex::new(State {
                    token: TOKEN_A.into(),
                    hello: Hello::Ok,
                    sessions: Vec::new(),
                    conns: Vec::new(),
                    requests: Vec::new(),
                    connections: 0,
                    silent: HashSet::new(),
                    next_sub: 1,
                    next_conn: 1,
                    tasks: Vec::new(),
                }),
            }),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.inner.state.lock().unwrap()
    }

    pub fn set_hello(&self, hello: Hello) {
        self.lock().hello = hello;
    }

    pub fn set_silent(&self, method: &str) {
        self.lock().silent.insert(method.to_string());
    }

    pub fn set_session(&self, snapshot: Value) {
        let id = snapshot["session"]["id"].as_str().unwrap().to_string();
        let mut state = self.lock();
        match state.sessions.iter_mut().find(|(known, _)| *known == id) {
            Some(entry) => entry.1 = snapshot,
            None => state.sessions.push((id, snapshot)),
        }
    }

    pub fn remove_session(&self, id: &str) {
        self.lock().sessions.retain(|(known, _)| known != id);
    }

    pub fn requests(&self) -> Vec<Value> {
        self.lock().requests.clone()
    }

    pub fn methods(&self) -> Vec<String> {
        self.requests()
            .iter()
            .map(|r| r["method"].as_str().unwrap_or("").to_string())
            .collect()
    }

    pub fn count(&self, method: &str) -> usize {
        self.methods().iter().filter(|m| *m == method).count()
    }

    /// Conexiones aceptadas en total.
    pub fn connections(&self) -> usize {
        self.lock().connections
    }

    pub fn live_connections(&self) -> usize {
        self.lock()
            .conns
            .iter()
            .filter(|c| !c.out.is_closed())
            .count()
    }

    /// Envía eventos a quien siga esa sesión.
    pub fn push_events(&self, session_id: &str, events: Vec<Value>) {
        let state = self.lock();
        for conn in &state.conns {
            for (sub, scope) in &conn.subs {
                if matches!(scope, Scope::Session(id) if id == session_id) {
                    let _ = conn.out.send(line(json!({
                        "method": "events", "params": { "subscriptionId": sub, "events": events }
                    })));
                }
            }
        }
    }

    /// Envía una foto (no pedida) a quien siga esa sesión.
    pub fn push_snapshot(&self, session_id: &str, snapshot: Value) {
        let state = self.lock();
        for conn in &state.conns {
            for (sub, scope) in &conn.subs {
                if matches!(scope, Scope::Session(id) if id == session_id) {
                    let _ = conn.out.send(line(json!({
                        "method": "snapshot", "params": { "subscriptionId": sub, "snapshot": snapshot }
                    })));
                }
            }
        }
    }

    /// Envía eventos a las suscripciones de conjunto.
    pub fn push_overview_events(&self, events: Vec<Value>) {
        let state = self.lock();
        for conn in &state.conns {
            for (sub, scope) in &conn.subs {
                if matches!(scope, Scope::Overview) {
                    let _ = conn.out.send(line(json!({
                        "method": "events", "params": { "subscriptionId": sub, "events": events }
                    })));
                }
            }
        }
    }

    /// Arranca: escucha en un canal nuevo y **después** publica el endpoint.
    pub fn start(&self, token: &str, endpoint_protocol: u64) {
        let n = PIPE_COUNTER.fetch_add(1, Ordering::Relaxed);
        #[cfg(windows)]
        let path = format!(r"\\.\pipe\dot-link-test-{}-{n}", std::process::id());
        #[cfg(unix)]
        let path = self
            .inner
            .dir
            .join(format!("d{n}.sock"))
            .to_string_lossy()
            .into_owned();
        self.lock().token = token.to_string();

        let fake = self.clone();
        #[cfg(windows)]
        let accept = {
            use tokio::net::windows::named_pipe::ServerOptions;
            let mut server = ServerOptions::new()
                .first_pipe_instance(true)
                .create(&path)
                .unwrap();
            let path = path.clone();
            tokio::spawn(async move {
                loop {
                    if server.connect().await.is_err() {
                        return;
                    }
                    let next = match ServerOptions::new().create(&path) {
                        Ok(next) => next,
                        Err(_) => return,
                    };
                    let stream = std::mem::replace(&mut server, next);
                    fake.serve(stream);
                }
            })
        };
        #[cfg(unix)]
        let accept = {
            let listener = tokio::net::UnixListener::bind(&path).unwrap();
            tokio::spawn(async move {
                loop {
                    let Ok((stream, _)) = listener.accept().await else {
                        return;
                    };
                    fake.serve(stream);
                }
            })
        };
        self.lock().tasks.push(accept);

        std::fs::create_dir_all(&self.inner.dir).unwrap();
        let endpoint = json!({
            "protocol": endpoint_protocol, "pid": std::process::id(),
            "startedAt": format!("2026-10-13T10:00:{:02}.000Z", n % 60),
            "version": "0.9.0-test", "ipcPath": path, "token": token,
        });
        std::fs::write(self.inner.dir.join("endpoint.json"), endpoint.to_string()).unwrap();
    }

    /// Muere sin despedirse. `remove_endpoint: false` es un `kill -9`: el
    /// endpoint se queda, rancio.
    pub fn stop(&self, remove_endpoint: bool) {
        let mut state = self.lock();
        for task in state.tasks.drain(..) {
            task.abort();
        }
        state.conns.clear();
        drop(state);
        if remove_endpoint {
            let _ = std::fs::remove_file(self.inner.dir.join("endpoint.json"));
        }
    }

    fn serve<S: AsyncRead + AsyncWrite + Send + 'static>(&self, stream: S) {
        let (out, mut outbox) = mpsc::unbounded_channel::<String>();
        let conn_id = {
            let mut state = self.lock();
            let id = state.next_conn;
            state.next_conn += 1;
            state.connections += 1;
            state.conns.push(ConnEntry {
                id,
                out: out.clone(),
                subs: Vec::new(),
            });
            id
        };
        let fake = self.clone();
        let task = tokio::spawn(async move {
            let (reader, mut writer) = tokio::io::split(stream);
            let mut lines = BufReader::new(reader).lines();
            loop {
                tokio::select! {
                    incoming = lines.next_line() => {
                        let Ok(Some(text)) = incoming else { break };
                        let Ok(msg) = serde_json::from_str::<Value>(&text) else { continue };
                        for reply in fake.handle(conn_id, msg) {
                            let _ = out.send(reply);
                        }
                    }
                    outgoing = outbox.recv() => {
                        let Some(text) = outgoing else { break };
                        if writer.write_all(text.as_bytes()).await.is_err() { break }
                    }
                }
            }
            fake.lock().conns.retain(|c| c.id != conn_id);
        });
        self.lock().tasks.push(task);
    }

    fn handle(&self, conn_id: u64, msg: Value) -> Vec<String> {
        let mut state = self.lock();
        let Some(method) = msg
            .get("method")
            .and_then(Value::as_str)
            .map(str::to_string)
        else {
            return Vec::new();
        };
        let id = msg.get("id").cloned().unwrap_or(Value::Null);
        let params = msg.get("params").cloned().unwrap_or_else(|| json!({}));
        state
            .requests
            .push(json!({ "method": method, "params": params, "conn": conn_id }));
        if state.silent.contains(&method) {
            return Vec::new();
        }
        let ok = |result: Value| line(json!({ "id": id, "result": result }));
        let err = |code: &str, data: Value| {
            line(
                json!({ "id": id, "error": { "code": code, "message": format!("{code} (test)"), "data": data } }),
            )
        };
        match method.as_str() {
            "core.hello" => match state.hello.clone() {
                _ if params["token"].as_str() != Some(state.token.as_str()) => {
                    vec![err("UNAUTHORIZED", json!({}))]
                }
                Hello::Unauthorized => vec![err("UNAUTHORIZED", json!({}))],
                Hello::Mismatch(protocol) => {
                    vec![err("PROTOCOL_MISMATCH", json!({ "protocol": protocol }))]
                }
                hello => vec![ok(json!({
                    "protocol": if let Hello::WrongVersion(v) = hello { v } else { 1 },
                    "server": { "version": "0.9.0-test", "platform": "test" },
                    "connectionId": conn_id, "capabilities": ["observe", "control"], "features": [],
                }))],
            },
            "events.subscribe" => {
                let sub = format!("sub_{}", state.next_sub);
                state.next_sub += 1;
                let scope = &params["scope"];
                if scope["kind"] == "overview" {
                    let sessions: Vec<Value> = state
                        .sessions
                        .iter()
                        .map(|(_, s)| s["session"].clone())
                        .collect();
                    let overview = json!({ "sessions": sessions, "approvals": [], "questions": [], "plans": [] });
                    if let Some(conn) = state.conns.iter_mut().find(|c| c.id == conn_id) {
                        conn.subs.push((sub.clone(), Scope::Overview));
                    }
                    return vec![
                        ok(json!({ "subscriptionId": sub, "mode": "snapshot" })),
                        line(
                            json!({ "method": "overview", "params": { "subscriptionId": sub, "overview": overview } }),
                        ),
                    ];
                }
                let session_id = scope["sessionId"].as_str().unwrap_or("").to_string();
                let Some(snapshot) = state
                    .sessions
                    .iter()
                    .find(|(id, _)| *id == session_id)
                    .map(|(_, s)| s.clone())
                else {
                    return vec![err("NOT_FOUND", json!({}))];
                };
                if let Some(conn) = state.conns.iter_mut().find(|c| c.id == conn_id) {
                    conn.subs.push((sub.clone(), Scope::Session(session_id)));
                }
                vec![
                    ok(json!({ "subscriptionId": sub, "mode": "snapshot" })),
                    line(
                        json!({ "method": "snapshot", "params": { "subscriptionId": sub, "snapshot": snapshot } }),
                    ),
                ]
            }
            "events.unsubscribe" => {
                let sub = params["subscriptionId"].as_str().unwrap_or("").to_string();
                if let Some(conn) = state.conns.iter_mut().find(|c| c.id == conn_id) {
                    conn.subs.retain(|(known, _)| *known != sub);
                }
                vec![ok(json!({}))]
            }
            "runs.pause" => vec![ok(json!({ "status": "requested" }))],
            "runs.resume" => vec![ok(json!({ "status": "resumed" }))],
            "runs.cancel" => vec![ok(json!({ "status": "cancelled" }))],
            "runs.steer" => {
                if params["sessionId"] == "detached" {
                    vec![err("UNAVAILABLE", json!({ "reason": "host-unavailable" }))]
                } else {
                    vec![ok(json!({ "status": "accepted" }))]
                }
            }
            // Como el daemon: la sesión nueva aparece por la suscripción de
            // conjunto (`session.opened`), no solo en la respuesta.
            "sessions.open" => {
                if params["cwd"] == "/no/existe" {
                    return vec![err("INVALID_PARAMS", json!({}))];
                }
                let n = state.sessions.len() + 1;
                let id = format!("ses_new_{n}");
                let mut snap = snapshot(&id, 1);
                snap["session"]["host"]["kind"] = json!("daemon");
                snap["session"]["state"] = json!("idle");
                snap["session"]["currentRunId"] = Value::Null;
                snap["run"] = Value::Null;
                let session = snap["session"].clone();
                state.sessions.push((id.clone(), snap));
                let opened = json!({
                    "type": "session.opened", "sessionId": id, "at": 11, "seq": 1,
                    "data": { "session": session }
                });
                for conn in &state.conns {
                    for (sub, scope) in &conn.subs {
                        if matches!(scope, Scope::Overview) {
                            let _ = conn.out.send(line(json!({
                                "method": "events", "params": { "subscriptionId": sub, "events": [opened] }
                            })));
                        }
                    }
                }
                vec![ok(json!({ "session": session }))]
            }
            "runs.start" => {
                let session_id = params["sessionId"].as_str().unwrap_or("");
                if !state.sessions.iter().any(|(id, _)| id == session_id) {
                    return vec![err("NOT_FOUND", json!({}))];
                }
                if params["input"] == "ocupada" {
                    return vec![err("BUSY", json!({}))];
                }
                vec![ok(json!({ "run": run_dto(session_id, "running") }))]
            }
            "agents.list" => vec![ok(json!({ "agents": [{
                "name": "general", "description": "", "mode": "all", "origin": "builtin",
                "allowedTools": null
            }] }))],
            "models.list" => vec![ok(json!({ "models": [{
                "provider": "local", "id": "mock-model", "contextWindow": null, "default": true
            }] }))],
            _ => vec![err("METHOD_NOT_FOUND", json!({}))],
        }
    }
}

/// Lanzador de pruebas: arranca el daemon falso, o falla.
pub struct FakeLauncher {
    pub fake: Fake,
    pub fail: bool,
    pub calls: Arc<AtomicU64>,
}

impl DaemonLauncher for FakeLauncher {
    fn start(&self) -> dot_link::launcher::LaunchFuture<'_> {
        Box::pin(async move {
            self.calls.fetch_add(1, Ordering::Relaxed);
            if self.fail {
                return Err("the `stratum` command was not found.".to_string());
            }
            self.fake.start(TOKEN_A, 1);
            Ok(())
        })
    }
}

/// Lo que recibe la «interfaz» en un test.
#[derive(Clone, Default)]
pub struct Seen {
    events: Arc<Mutex<Vec<DotEvent>>>,
}

impl Seen {
    pub fn all(&self) -> Vec<DotEvent> {
        self.events.lock().unwrap().clone()
    }

    pub fn clear(&self) {
        self.events.lock().unwrap().clear();
    }

    /// Los estados de conexión, en orden.
    pub fn states(&self) -> Vec<String> {
        self.all()
            .iter()
            .filter_map(|e| match e {
                DotEvent::Connection { state } => Some(state.name().to_string()),
                _ => None,
            })
            .collect()
    }

    pub fn snapshots(&self, session_id: &str) -> Vec<Value> {
        self.all()
            .into_iter()
            .filter_map(|e| match e {
                DotEvent::Snapshot {
                    session_id: id,
                    snapshot,
                } if id == session_id => Some(snapshot),
                _ => None,
            })
            .collect()
    }

    pub fn events(&self, session_id: &str) -> Vec<Value> {
        self.all()
            .into_iter()
            .filter_map(|e| match e {
                DotEvent::Events {
                    session_id: id,
                    events,
                } if id == session_id => Some(events),
                _ => None,
            })
            .flatten()
            .collect()
    }

    pub fn last_sessions(&self) -> Option<Vec<String>> {
        self.all().into_iter().rev().find_map(|e| match e {
            DotEvent::Sessions { session_ids } => Some(session_ids),
            _ => None,
        })
    }
}

pub async fn until(what: &str, mut probe: impl FnMut() -> bool) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    while !probe() {
        if tokio::time::Instant::now() > deadline {
            panic!("no se cumplió a tiempo: {what}");
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

pub fn fast() -> Timings {
    Timings {
        backoff_initial: Duration::from_millis(20),
        backoff_max: Duration::from_millis(80),
        request_timeout: Duration::from_millis(400),
        open_timeout: Duration::from_millis(900),
        handshake_timeout: Duration::from_millis(400),
        daemon_start_wait: Duration::from_millis(800),
        idle_poll: Duration::from_millis(40),
        connect_wait: Duration::from_millis(200),
    }
}

pub struct Rig {
    pub link: LinkHandle,
    pub seen: Seen,
    pub log_dir: PathBuf,
    task: JoinHandle<()>,
}

impl Rig {
    pub fn log(&self) -> String {
        std::fs::read_to_string(self.log_dir.join("dot.log")).unwrap_or_default()
    }

    /// Cierra Dot y espera a que el enlace termine.
    pub async fn quit(self) {
        self.link.shutdown();
        let _ = tokio::time::timeout(Duration::from_secs(5), self.task).await;
    }
}

/// Lanza el enlace de Dot contra la carpeta de endpoint `dir`.
pub fn dot(dir: &Path, launcher: Option<Arc<dyn DaemonLauncher>>) -> Rig {
    let seen = Seen::default();
    let sink = seen.clone();
    let log_dir = dir.join("logs");
    let (link, task) = dot_link::spawn(
        LinkConfig {
            endpoint_dir: dir.to_path_buf(),
            client_version: "0.1.0-test".into(),
            autostart: launcher.is_some(),
            launcher: launcher.unwrap_or_else(|| Arc::new(NoLauncher)),
            logger: Logger::to_dir(&log_dir),
            timings: fast(),
        },
        move |event| sink.events.lock().unwrap().push(event),
    );
    Rig {
        link,
        seen,
        log_dir,
        task: tokio::spawn(task),
    }
}
