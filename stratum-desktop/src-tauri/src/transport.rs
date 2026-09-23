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
pub const PROTOCOL_VERSION: u64 = 6;

/// Tipos que el frontend puede mandar (`CLIENT_FRAME_TYPES` en `protocol.ts`).
pub const CLIENT_FRAME_TYPES: [&str; 24] = [
    "ping",
    "new_conversation",
    "close_conversation",
    "chat",
    "cancel",
    "answer_questions",
    "confirm_response",
    "workspace_pin",
    "list_conversations",
    "rename_conversation",
    "delete_conversation",
    "clear_conversation",
    "compact_conversation",
    "list_models",
    "set_model",
    "memory_get",
    "memory_save",
    "memory_forget",
    "config_get",
    "config_validate",
    "config_save",
    "provider_probe",
    "retention_run",
    "workspaces_usage_get",
];

/// Tope de una trama del frontend (`MAX_FRAME_BYTES` en `protocol.ts`). Se
/// comprueba aquí para no escribir al pipe algo que el sidecar va a rechazar.
pub const MAX_CLIENT_FRAME_BYTES: usize = 1024 * 1024;

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
    /// Raíz y límites de los workspaces (D2). Se queda en Rust: no se reenvía.
    pub workspaces: Option<Value>,
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
        workspaces: frame.get("workspaces").cloned(),
    })
}

/// Valida una trama del frontend y la serializa como línea NDJSON.
///
/// Primera barrera: tipo en la lista blanca y tamaño acotado. El frontend
/// nunca habla de autenticación, así que un `handshake` desde el webview no
/// llega al pipe. La validación campo a campo la hace el sidecar (`codec.ts`).
pub fn outbound_line(frame: &Value) -> Result<String, String> {
    let obj = frame
        .as_object()
        .ok_or("la trama debe ser un objeto JSON")?;
    match obj.get("type").and_then(Value::as_str) {
        None => return Err("la trama necesita un campo `type` de texto".into()),
        Some("handshake") => return Err("el frontend no puede enviar handshakes".into()),
        Some(t) if !CLIENT_FRAME_TYPES.contains(&t) => {
            return Err(format!("tipo de trama no permitido: {t}"))
        }
        Some(_) => {}
    }
    let mut line = frame.to_string();
    if line.len() > MAX_CLIENT_FRAME_BYTES {
        return Err(format!(
            "la trama supera el límite de {MAX_CLIENT_FRAME_BYTES} bytes"
        ));
    }
    line.push('\n');
    Ok(line)
}

/// Trama que origina el propio Rust (`workspace_touch`): no pasa por la lista
/// blanca del frontend, que es justo lo que impide al webview emitirla.
pub fn internal_line(frame: &Value) -> String {
    let mut line = frame.to_string();
    line.push('\n');
    line
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
            &json!({"type":"handshake_ok","core":{"protocolVersion":6,"version":"0.4.0"},"natives":[]})
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

    #[test]
    fn solo_pasan_los_tipos_de_la_lista_blanca() {
        for t in CLIENT_FRAME_TYPES {
            assert!(outbound_line(&json!({ "type": t })).is_ok(), "{t}");
        }
        for t in ["handshake_ok", "agent_event", "shutdown", "rehydrate", "workspace_touch"] {
            let err = outbound_line(&json!({ "type": t })).unwrap_err();
            assert!(err.contains("no permitido"), "{t}: {err}");
        }
    }

    #[test]
    fn rechaza_una_trama_por_encima_del_limite() {
        let text = "x".repeat(MAX_CLIENT_FRAME_BYTES);
        let err = outbound_line(&json!({ "type": "chat", "text": text })).unwrap_err();
        assert!(err.contains("límite"), "{err}");
    }
}
