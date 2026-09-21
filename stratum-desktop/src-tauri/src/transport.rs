//! Canal local con el sidecar: named pipe (Windows) o unix socket (Linux) con
//! NDJSON (§3, 15.1, 15.10). El protocolo lo define
//! `stratum-cli/src/desktop/protocol.ts`; aquí solo lo imprescindible para el
//! handshake y para filtrar lo que manda el frontend.
//!
//! El handshake lo hace Rust, no el webview: el token no sale nunca del proceso
//! Tauri, así que un fallo de contenido en el webview (un markdown hostil en D1)
//! no puede filtrarlo para conectarse al pipe por otra vía.

use serde_json::Value;
use std::io;
use std::time::{Duration, Instant};

/// Versión del protocolo que entiende este shell (`DESKTOP_PROTOCOL_VERSION`).
pub const PROTOCOL_VERSION: u64 = 1;

#[cfg(windows)]
pub type Stream = tokio::net::windows::named_pipe::NamedPipeClient;
#[cfg(unix)]
pub type Stream = tokio::net::UnixStream;

/// Intenta conectar hasta `timeout`: el sidecar tarda en abrir el pipe.
/// `alive` se consulta entre intentos para no esperar a un proceso que ya murió.
pub async fn connect(
    path: &str,
    timeout: Duration,
    mut alive: impl FnMut() -> Result<(), String>,
) -> Result<Stream, String> {
    let deadline = Instant::now() + timeout;
    loop {
        match try_connect(path).await {
            Ok(stream) => return Ok(stream),
            Err(e) if Instant::now() >= deadline => {
                return Err(format!("no se pudo conectar con el sidecar en {path}: {e}"))
            }
            Err(_) => {}
        }
        alive()?;
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

#[cfg(windows)]
async fn try_connect(path: &str) -> io::Result<Stream> {
    tokio::net::windows::named_pipe::ClientOptions::new().open(path)
}

#[cfg(unix)]
async fn try_connect(path: &str) -> io::Result<Stream> {
    tokio::net::UnixStream::connect(path).await
}

pub fn handshake_line(token: &str) -> String {
    let mut line = serde_json::json!({ "type": "handshake", "token": token }).to_string();
    line.push('\n');
    line
}

/// Resultado de un handshake aceptado: lo que se reenvía al frontend.
#[derive(Debug, Clone, PartialEq)]
pub struct HandshakeInfo {
    pub core: Value,
    pub natives: Value,
}

pub fn parse_handshake_reply(line: &str) -> Result<HandshakeInfo, String> {
    let frame: Value = serde_json::from_str(line)
        .map_err(|e| format!("respuesta de handshake no es JSON: {e}"))?;
    match frame.get("type").and_then(Value::as_str) {
        Some("handshake_ok") => {}
        Some("handshake_error") => {
            let reason = frame
                .get("reason")
                .and_then(Value::as_str)
                .unwrap_or("desconocido");
            return Err(format!("el sidecar rechazó el handshake: {reason}"));
        }
        other => return Err(format!("respuesta de handshake inesperada: {other:?}")),
    }
    let core = frame.get("core").cloned().unwrap_or(Value::Null);
    let version = core.get("protocolVersion").and_then(Value::as_u64);
    if version != Some(PROTOCOL_VERSION) {
        return Err(format!(
            "versión de protocolo incompatible: el sidecar habla {version:?}, este shell la {PROTOCOL_VERSION}"
        ));
    }
    Ok(HandshakeInfo {
        core,
        natives: frame
            .get("natives")
            .cloned()
            .unwrap_or(Value::Array(vec![])),
    })
}

/// Valida una trama del frontend y la serializa como línea NDJSON.
///
/// El frontend nunca habla de autenticación: un `handshake` desde el webview se
/// rechaza aquí, antes de llegar al pipe.
pub fn outbound_line(frame: &Value) -> Result<String, String> {
    let obj = frame
        .as_object()
        .ok_or("la trama debe ser un objeto JSON")?;
    match obj.get("type").and_then(Value::as_str) {
        None => Err("la trama necesita un campo `type` de texto".into()),
        Some("handshake") => Err("el frontend no puede enviar handshakes".into()),
        Some(_) => {
            let mut line = frame.to_string();
            line.push('\n');
            Ok(line)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn handshake_line_es_una_linea_json() {
        let line = handshake_line("abc");
        assert!(line.ends_with('\n'));
        assert_eq!(line.matches('\n').count(), 1);
        let v: Value = serde_json::from_str(line.trim_end()).unwrap();
        assert_eq!(v, json!({"type": "handshake", "token": "abc"}));
    }

    #[test]
    fn acepta_handshake_ok_con_la_version_de_protocolo() {
        let info = parse_handshake_reply(
            &json!({"type":"handshake_ok","core":{"protocolVersion":1,"version":"0.4.0"},"natives":[]})
                .to_string(),
        )
        .unwrap();
        assert_eq!(info.core["version"], "0.4.0");
    }

    #[test]
    fn rechaza_version_de_protocolo_distinta() {
        let err = parse_handshake_reply(
            &json!({"type":"handshake_ok","core":{"protocolVersion":2}}).to_string(),
        )
        .unwrap_err();
        assert!(err.contains("incompatible"), "{err}");
    }

    #[test]
    fn propaga_el_motivo_de_un_rechazo() {
        let err = parse_handshake_reply(r#"{"type":"handshake_error","reason":"bad_token"}"#)
            .unwrap_err();
        assert!(err.contains("bad_token"));
        assert!(parse_handshake_reply("no json").is_err());
    }

    #[test]
    fn el_frontend_no_puede_mandar_handshakes_ni_tramas_sin_tipo() {
        assert!(outbound_line(&json!({"type":"handshake","token":"x"})).is_err());
        assert!(outbound_line(&json!({"id":"1"})).is_err());
        assert!(outbound_line(&json!("ping")).is_err());
        assert_eq!(
            outbound_line(&json!({"type":"ping","id":"1"})).unwrap(),
            "{\"id\":\"1\",\"type\":\"ping\"}\n"
        );
    }
}
