//! `logs/sidecar.log` (15.11): stdout y stderr del sidecar van a un fichero,
//! nunca a una consola ni al protocolo. Rotación simple al arrancar para que un
//! sidecar muy verboso no llene el disco entre reinicios.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, Runtime};

pub const SIDECAR_LOG: &str = "sidecar.log";

/// Tamaño a partir del cual se rota al arrancar.
pub const MAX_LOG_BYTES: u64 = 5 * 1024 * 1024;

/// Ficheros rotados que se conservan (`sidecar.log.1` … `.N`).
pub const KEEP_ROTATED: usize = 3;

/// Bytes finales de `sidecar.log` que se leen para la pantalla de fallo (D6).
const TAIL_BYTES: u64 = 64 * 1024;

/// Carpeta de logs de la app. Sin directorio de logs (perfil de usuario raro),
/// el temporal del sistema: quedarse sin log no puede dejar a la app sin agente.
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
    Ok(all[from..].join("
"))
}

/// Abre (en modo append) el log del sidecar en `dir`, rotándolo antes si supera `max_bytes`.
pub fn open_sidecar_log(dir: &Path, max_bytes: u64, keep: usize) -> io::Result<(File, PathBuf)> {
    fs::create_dir_all(dir)?;
    let path = dir.join(SIDECAR_LOG);
    rotate_if_large(&path, max_bytes, keep)?;
    let file = OpenOptions::new().create(true).append(true).open(&path)?;
    Ok((file, path))
}

fn rotated(path: &Path, n: usize) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(format!(".{n}"));
    PathBuf::from(name)
}

/// `log` → `log.1` → … → `log.keep`; lo que cae de `log.keep` se borra.
pub fn rotate_if_large(path: &Path, max_bytes: u64, keep: usize) -> io::Result<bool> {
    match fs::metadata(path) {
        Ok(meta) if meta.len() > max_bytes => {}
        Ok(_) => return Ok(false),
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(e),
    }
    if keep == 0 {
        fs::remove_file(path)?;
        return Ok(true);
    }
    let oldest = rotated(path, keep);
    if oldest.exists() {
        fs::remove_file(&oldest)?;
    }
    for n in (1..keep).rev() {
        let from = rotated(path, n);
        if from.exists() {
            fs::rename(&from, rotated(path, n + 1))?;
        }
    }
    fs::rename(path, rotated(path, 1))?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write(path: &Path, bytes: usize) {
        let mut f = File::create(path).unwrap();
        f.write_all(&vec![b'x'; bytes]).unwrap();
    }

    #[test]
    fn no_rota_por_debajo_del_tope() {
        let dir = tempfile::tempdir().unwrap();
        let log = dir.path().join(SIDECAR_LOG);
        write(&log, 10);
        assert!(!rotate_if_large(&log, 100, 3).unwrap());
        assert!(log.exists());
    }

    #[test]
    fn rota_y_conserva_solo_keep_ficheros() {
        let dir = tempfile::tempdir().unwrap();
        let log = dir.path().join(SIDECAR_LOG);
        for _ in 0..5 {
            write(&log, 200);
            assert!(rotate_if_large(&log, 100, 2).unwrap());
        }
        assert!(!log.exists());
        assert!(rotated(&log, 1).exists());
        assert!(rotated(&log, 2).exists());
        assert!(!rotated(&log, 3).exists());
    }

    #[test]
    fn read_tail_devuelve_las_ultimas_lineas() {
        let dir = tempfile::tempdir().unwrap();
        let log = dir.path().join(SIDECAR_LOG);
        assert_eq!(read_tail(&log, 5).unwrap(), "");
        fs::write(&log, "a
b
c
d
").unwrap();
        assert_eq!(read_tail(&log, 2).unwrap(), "c
d");
        assert_eq!(read_tail(&log, 10).unwrap(), "a
b
c
d");
        // Más grande que la ventana de lectura: la primera línea (cortada) se descarta.
        let big = format!("{}
fin
", "x".repeat(TAIL_BYTES as usize + 10));
        fs::write(&log, big).unwrap();
        assert_eq!(read_tail(&log, 10).unwrap(), "fin");
    }

    #[test]
    fn open_crea_el_directorio() {
        let dir = tempfile::tempdir().unwrap();
        let nested = dir.path().join("a").join("logs");
        let (_file, path) = open_sidecar_log(&nested, MAX_LOG_BYTES, KEEP_ROTATED).unwrap();
        assert_eq!(path, nested.join(SIDECAR_LOG));
        assert!(path.exists());
    }
}
