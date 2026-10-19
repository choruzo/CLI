//! Logs de la app (15.11). Desde M12 no hay sidecar: el único log es el del
//! enlace con `stratumd` (`desktop.log`, lo escribe y rota `dot_link::Logger`).
//! Lo que nunca lleva: el token del canal, claves ni el contenido de las sesiones.

use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, Runtime};

/// Log del enlace con el daemon.
pub const LINK_LOG: &str = "desktop.log";

/// Bytes finales del log que se leen para la pantalla de fallo (D6).
const TAIL_BYTES: u64 = 64 * 1024;

/// Carpeta de logs de la app. Sin directorio de logs (perfil de usuario raro),
/// el temporal del sistema: quedarse sin log no puede dejar a la app sin conexión.
pub fn log_dir<R: Runtime>(app: &AppHandle<R>) -> PathBuf {
    app.path()
        .app_log_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("stratum-desktop").join("logs"))
}

/// Últimas `lines` líneas de un log (lee como mucho los últimos 64 KiB; la
/// primera línea, posiblemente cortada, se descarta si no se leyó desde el inicio).
/// Un fichero que no existe es un log vacío.
pub fn read_tail(path: &Path, lines: usize) -> io::Result<String> {
    let mut file = match File::open(path) {
        Ok(f) => f,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(String::new()),
        Err(e) => return Err(e),
    };
    let len = file.metadata()?.len();
    let start = len.saturating_sub(TAIL_BYTES);
    file.seek(SeekFrom::Start(start))?;
    let mut buf = Vec::new();
    file.read_to_end(&mut buf)?;
    let text = String::from_utf8_lossy(&buf);
    let mut all: Vec<&str> = text.lines().collect();
    if start > 0 && !all.is_empty() {
        all.remove(0);
    }
    let from = all.len().saturating_sub(lines);
    Ok(all[from..].join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn read_tail_devuelve_las_ultimas_lineas() {
        let dir = tempfile::tempdir().unwrap();
        let log = dir.path().join(LINK_LOG);
        assert_eq!(read_tail(&log, 5).unwrap(), "");
        fs::write(&log, "a\nb\nc\nd\n").unwrap();
        assert_eq!(read_tail(&log, 2).unwrap(), "c\nd");
        assert_eq!(read_tail(&log, 10).unwrap(), "a\nb\nc\nd");
        // Más grande que la ventana de lectura: la primera línea (cortada) se descarta.
        let big = format!("{}\nfin\n", "x".repeat(TAIL_BYTES as usize + 10));
        fs::write(&log, big).unwrap();
        assert_eq!(read_tail(&log, 10).unwrap(), "fin");
    }
}
