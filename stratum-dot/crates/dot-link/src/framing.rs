//! NDJSON: un mensaje por línea, UTF-8, terminado en `\n` (`docs/protocol.md` §2).
//! Equivale a `LineDecoder` de `stratum-cli/src/ipc/framing.ts`.

/// Una línea supera el límite: la conexión no puede seguir.
#[derive(Debug, PartialEq, Eq)]
pub struct FrameTooLarge {
    pub limit: usize,
}

/// Acumula bytes y devuelve líneas completas. Una línea a medias cuando la
/// conexión se corta no es un mensaje: se queda aquí y se descarta.
pub struct LineDecoder {
    buffer: Vec<u8>,
    max_bytes: usize,
}

impl LineDecoder {
    pub fn new(max_bytes: usize) -> Self {
        Self {
            buffer: Vec::new(),
            max_bytes,
        }
    }

    /// Añade un bloque y devuelve las líneas que se completan con él. Las
    /// líneas vacías se saltan; una que no es UTF-8 válido se descarta (no es
    /// un mensaje del protocolo).
    pub fn push(&mut self, chunk: &[u8]) -> Result<Vec<String>, FrameTooLarge> {
        let mut lines = Vec::new();
        let mut rest = chunk;
        while let Some(nl) = rest.iter().position(|b| *b == b'\n') {
            if self.buffer.len() + nl > self.max_bytes {
                return Err(FrameTooLarge {
                    limit: self.max_bytes,
                });
            }
            self.buffer.extend_from_slice(&rest[..nl]);
            rest = &rest[nl + 1..];
            let mut line = std::mem::take(&mut self.buffer);
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            if line.is_empty() {
                continue;
            }
            if let Ok(text) = String::from_utf8(line) {
                lines.push(text);
            }
        }
        if self.buffer.len() + rest.len() > self.max_bytes {
            return Err(FrameTooLarge {
                limit: self.max_bytes,
            });
        }
        self.buffer.extend_from_slice(rest);
        Ok(lines)
    }

    /// Bytes de una línea que no llegó a terminar.
    pub fn pending(&self) -> usize {
        self.buffer.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn varias_lineas_en_un_bloque() {
        let mut d = LineDecoder::new(64);
        assert_eq!(
            d.push(b"{\"a\":1}\n{\"b\":2}\n").unwrap(),
            vec!["{\"a\":1}", "{\"b\":2}"]
        );
        assert_eq!(d.pending(), 0);
    }

    #[test]
    fn byte_a_byte_y_multibyte_partido() {
        let mut d = LineDecoder::new(64);
        let text = "{\"t\":\"ñandú €\"}\n";
        let mut out = Vec::new();
        for b in text.as_bytes() {
            out.extend(d.push(&[*b]).unwrap());
        }
        assert_eq!(out, vec!["{\"t\":\"ñandú €\"}"]);
    }

    #[test]
    fn una_linea_a_medias_no_se_entrega() {
        let mut d = LineDecoder::new(64);
        assert!(d.push(b"{\"a\":").unwrap().is_empty());
        assert_eq!(d.pending(), 5);
    }

    #[test]
    fn lineas_vacias_y_crlf() {
        let mut d = LineDecoder::new(64);
        assert_eq!(d.push(b"\n\r\n{}\r\n").unwrap(), vec!["{}"]);
    }

    #[test]
    fn por_encima_del_limite_falla() {
        let mut d = LineDecoder::new(8);
        assert_eq!(d.push(b"123456789"), Err(FrameTooLarge { limit: 8 }));
        let mut d = LineDecoder::new(8);
        assert!(d.push(b"12345").is_ok());
        assert_eq!(d.push(b"6789\n"), Err(FrameTooLarge { limit: 8 }));
        // Justo en el límite cabe.
        let mut d = LineDecoder::new(8);
        assert_eq!(d.push(b"12345678\n").unwrap(), vec!["12345678"]);
    }

    #[test]
    fn utf8_invalido_se_descarta() {
        let mut d = LineDecoder::new(64);
        assert_eq!(
            d.push(&[0xff, 0xfe, b'\n', b'{', b'}', b'\n']).unwrap(),
            vec!["{}"]
        );
    }
}
