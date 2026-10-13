//! Log de Dot: un fichero de texto, una línea por suceso. Sirve para saber qué
//! pasó con la conexión (arranque, descubrimiento, daemon, reconexiones).
//!
//! Lo que **nunca** se escribe: el token del canal, claves, entorno ni el
//! contenido de los eventos de una sesión. Quien registra pasa textos fijos y
//! datos del sobre (códigos, contadores, ids de sesión), no payloads.

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

pub const LOG_FILE: &str = "dot.log";

/// Tamaño a partir del cual se rota al arrancar (`dot.log` → `dot.log.1`).
pub const MAX_LOG_BYTES: u64 = 2 * 1024 * 1024;

#[derive(Clone, Default)]
pub struct Logger {
    file: Option<Arc<Mutex<File>>>,
    path: Option<PathBuf>,
}

impl Logger {
    /// Sin fichero: no registra nada.
    pub fn none() -> Self {
        Self::default()
    }

    /// Abre `dir/dot.log` en modo append, rotándolo antes si es grande. Si no
    /// se puede, Dot sigue sin log: quedarse sin log no puede dejarla sin conexión.
    pub fn to_dir(dir: &Path) -> Self {
        let path = dir.join(LOG_FILE);
        let open = || -> std::io::Result<File> {
            fs::create_dir_all(dir)?;
            if fs::metadata(&path)
                .map(|m| m.len() > MAX_LOG_BYTES)
                .unwrap_or(false)
            {
                let mut rotated = path.clone().into_os_string();
                rotated.push(".1");
                let _ = fs::remove_file(&rotated);
                fs::rename(&path, &rotated)?;
            }
            OpenOptions::new().create(true).append(true).open(&path)
        };
        match open() {
            Ok(file) => Self {
                file: Some(Arc::new(Mutex::new(file))),
                path: Some(path),
            },
            Err(_) => Self::none(),
        }
    }

    pub fn path(&self) -> Option<&Path> {
        self.path.as_deref()
    }

    pub fn info(&self, message: &str) {
        self.write("info", message);
    }

    pub fn warn(&self, message: &str) {
        self.write("warn", message);
    }

    pub fn error(&self, message: &str) {
        self.write("error", message);
    }

    fn write(&self, level: &str, message: &str) {
        let Some(file) = &self.file else { return };
        let ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        // Una línea por suceso: un salto dentro del mensaje no parte el registro.
        let flat = message.replace(['\n', '\r'], " ");
        if let Ok(mut file) = file.lock() {
            let _ = writeln!(file, "{ms} {level} {flat}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escribe_una_linea_por_suceso() {
        let dir = tempfile::tempdir().unwrap();
        let log = Logger::to_dir(&dir.path().join("logs"));
        log.info("dot startup");
        log.warn("dos\nlineas");
        let text = fs::read_to_string(log.path().unwrap()).unwrap();
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines.len(), 2);
        assert!(lines[0].ends_with(" info dot startup"), "{}", lines[0]);
        assert!(lines[1].ends_with(" warn dos lineas"), "{}", lines[1]);
    }

    #[test]
    fn rota_un_log_grande_al_abrir() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(LOG_FILE);
        fs::write(&path, vec![b'x'; (MAX_LOG_BYTES + 1) as usize]).unwrap();
        let log = Logger::to_dir(dir.path());
        log.info("nuevo");
        assert!(dir.path().join("dot.log.1").exists());
        assert!(fs::metadata(&path).unwrap().len() < 100);
    }

    #[test]
    fn sin_fichero_no_falla() {
        Logger::none().info("nada");
    }
}
