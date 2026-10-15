//! Lo común a las páginas nativas de Dot (desbloqueo y confirmación): se
//! sirven desde Rust por un esquema propio, con una CSP que no deja cargar ni
//! enviar nada fuera de su origen, y sin caché.

use tauri::http::{header, Response, StatusCode};

pub const CSP: &str =
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; \
     img-src 'none'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'";

/// Lo más que se acepta en el cuerpo de una petición de estas páginas.
pub const MAX_BODY: usize = 4 * 1024;

/// La hoja de estilos común.
pub const BASE_STYLE: &str = include_str!("../unlock/unlock.css");

pub fn respond(status: StatusCode, content_type: &str, body: Vec<u8>) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, content_type)
        .header(header::CONTENT_SECURITY_POLICY, CSP)
        .header(header::CACHE_CONTROL, "no-store")
        .header("X-Content-Type-Options", "nosniff")
        .header("Referrer-Policy", "no-referrer")
        .body(body)
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

pub fn json(value: &serde_json::Value) -> Response<Vec<u8>> {
    respond(
        StatusCode::OK,
        "application/json",
        value.to_string().into_bytes(),
    )
}

pub fn not_found() -> Response<Vec<u8>> {
    respond(StatusCode::NOT_FOUND, "text/plain", b"not found".to_vec())
}

pub fn forbidden() -> Response<Vec<u8>> {
    respond(StatusCode::FORBIDDEN, "text/plain", b"forbidden".to_vec())
}
