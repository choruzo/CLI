//! `logs/sidecar.log` (15.11): stdout y stderr del sidecar van a un fichero,
//! nunca a una consola ni al protocolo. Rotación simple al arrancar para que un
//! sidecar muy verboso no llene el disco entre reinicios.

use std::fs::{self, File, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};

pub const SIDECAR_LOG: &str = "sidecar.log";

/// Tamaño a partir del cual se rota al arrancar.
pub const MAX_LOG_BYTES: u64 = 5 * 1024 * 1024;

/// Ficheros rotados que se conservan (`sidecar.log.1` … `.N`).
pub const KEEP_ROTATED: usize = 3;

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
    fn open_crea_el_directorio() {
        let dir = tempfile::tempdir().unwrap();
        let nested = dir.path().join("a").join("logs");
        let (_file, path) = open_sidecar_log(&nested, MAX_LOG_BYTES, KEEP_ROTATED).unwrap();
        assert_eq!(path, nested.join(SIDECAR_LOG));
        assert!(path.exists());
    }
}
