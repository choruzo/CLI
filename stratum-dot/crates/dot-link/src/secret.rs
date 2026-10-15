//! La clave de aprobador mientras está en la memoria del lado nativo.
//!
//! Vive lo justo: la recibe [`crate::approver`] del formulario de desbloqueo,
//! se escribe **una vez** en el `core.hello` de la conexión de aprobador y se
//! borra. Después la autoridad es la conexión ya acreditada, no la clave: no
//! se guarda para reconectar, ni en memoria ni en disco.
//!
//! Lo que el tipo garantiza:
//!
//!  - No implementa `Clone`, `Debug`, `Display` ni `Serialize`: no se puede
//!    copiar, imprimir, registrar ni enviar al webview por descuido.
//!  - Se borra (`zeroize`) al soltarse, también si no valía.
//!  - La línea del `hello` se escribe en un búfer reservado de una vez y que
//!    también se borra, así que no quedan copias intermedias de `serde_json`.
//!
//! Lo que no garantiza: las copias que hacen otros y no se borran — el motor
//! del webview de la ventana de desbloqueo, Tauri/wry al pasar el cuerpo de la
//! petición, la pila de E/S de este mismo proceso (en Windows, `mio` copia lo
//! que se escribe en el pipe a un búfer suyo que reutiliza sin poner a cero) y
//! el sistema operativo. Quien puede leerlas es quien puede leer la memoria del
//! proceso: el mismo usuario (Q2). Ver `docs/dot.md` §13.8.

use serde_json::{Map, Value};
use zeroize::{Zeroize, Zeroizing};

use crate::wire::{ApproverMethod, WireMethod};

/// Tope de la clave (`LIMITS.approverKeyChars`).
pub const MAX_APPROVER_KEY_CHARS: usize = 1_024;

/// Por qué lo recibido no es una clave. Sin el contenido.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SecretError {
    Empty,
    TooLong,
    NotText,
}

/// La clave de aprobador. Ver el módulo.
pub struct ApproverSecret(Zeroizing<String>);

impl ApproverSecret {
    /// Toma posesión de los bytes recibidos (UTF-8). Lo que no vale se borra
    /// antes de devolver el error.
    pub fn from_bytes(bytes: Vec<u8>) -> Result<Self, SecretError> {
        let mut bytes = Zeroizing::new(bytes);
        if bytes.is_empty() {
            return Err(SecretError::Empty);
        }
        let text = match String::from_utf8(std::mem::take(&mut *bytes)) {
            Ok(text) => Zeroizing::new(text),
            Err(err) => {
                err.into_bytes().zeroize();
                return Err(SecretError::NotText);
            }
        };
        if text.chars().count() > MAX_APPROVER_KEY_CHARS {
            return Err(SecretError::TooLong);
        }
        Ok(Self(text))
    }

    /// La línea NDJSON del saludo (id 1) con la clave dentro. `params` son los
    /// demás campos del saludo y no pueden llevar `approverKey`. Consume la
    /// clave: después del saludo ya no existe.
    pub(crate) fn into_hello_line(self, params: &Map<String, Value>) -> Zeroizing<Vec<u8>> {
        debug_assert!(!params.contains_key("approverKey"));
        let method = ApproverMethod::CoreHello.name();
        let rest = Value::Object(params.clone()).to_string();
        let parts: [&[u8]; 3] = [
            br#"{"id":1,"method":""#,
            method.as_bytes(),
            br#"","params":{"approverKey":"#,
        ];
        let head: usize = parts.iter().map(|p| p.len()).sum();
        // Peor caso de escape JSON: `\u00XX` (6 bytes) por byte de la clave.
        let capacity = head + 2 + self.0.len() * 6 + 1 + rest.len() + 2;
        let mut line = Zeroizing::new(Vec::with_capacity(capacity));
        let buffer = line.as_ptr();
        for part in parts {
            line.extend_from_slice(part);
        }
        // Escribir en un `Vec` con sitio de sobra no realoja: no deja copias sueltas.
        let _ = serde_json::to_writer(&mut *line, self.0.as_str());
        if rest.len() > 2 {
            line.push(b',');
            line.extend_from_slice(&rest.as_bytes()[1..rest.len() - 1]);
        }
        line.extend_from_slice(b"}}\n");
        debug_assert!(line.as_ptr() == buffer, "the hello line reallocated");
        line
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn lo_que_no_es_una_clave_se_rechaza() {
        assert_eq!(
            ApproverSecret::from_bytes(Vec::new()).err(),
            Some(SecretError::Empty)
        );
        assert_eq!(
            ApproverSecret::from_bytes(vec![0xff, 0xfe]).err(),
            Some(SecretError::NotText)
        );
        assert_eq!(
            ApproverSecret::from_bytes("x".repeat(MAX_APPROVER_KEY_CHARS + 1).into_bytes()).err(),
            Some(SecretError::TooLong)
        );
        assert!(ApproverSecret::from_bytes("clave de prueba".into()).is_ok());
    }

    #[test]
    fn el_saludo_lleva_la_clave_escapada_y_el_resto_de_campos() {
        let secret = ApproverSecret::from_bytes("cla\"ve \\ ñ\n".into()).unwrap();
        let mut params = Map::new();
        params.insert("protocol".into(), json!(1));
        params.insert("roles".into(), json!(["approver"]));
        let line = secret.into_hello_line(&params);
        assert_eq!(line.last(), Some(&b'\n'));
        let text = std::str::from_utf8(&line[..line.len() - 1]).unwrap();
        assert_eq!(text.matches('\n').count(), 0);
        let parsed: Value = serde_json::from_str(text).unwrap();
        assert_eq!(
            parsed,
            json!({
                "id": 1, "method": "core.hello",
                "params": { "approverKey": "cla\"ve \\ ñ\n", "protocol": 1, "roles": ["approver"] }
            })
        );
    }

    #[test]
    fn sin_mas_campos_tambien_es_json() {
        let secret = ApproverSecret::from_bytes("k".into()).unwrap();
        let line = secret.into_hello_line(&Map::new());
        let parsed: Value = serde_json::from_slice(&line[..line.len() - 1]).unwrap();
        assert_eq!(parsed["params"], json!({ "approverKey": "k" }));
    }
}
