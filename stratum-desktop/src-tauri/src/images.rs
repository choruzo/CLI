//! Imágenes pegadas en el campo de mensaje (Ctrl+V). El webview entrega los
//! bytes; aquí se validan (firma PNG/JPEG/WebP/GIF y ≤ 5 MB, igual que el
//! daemon), se guardan en `<home>/.stratum/images/` —uno de los dos sitios de
//! los que el daemon acepta leer imágenes— y se devuelve la ruta absoluta, que
//! viaja en `images` de `runs.start`/`runs.steer`. Las guardadas caducan solas:
//! cada guardado borra de ese directorio lo de más de 15 días.

use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Tope de una imagen (el del daemon).
pub const MAX_IMAGE_BYTES: usize = 5 * 1024 * 1024;
/// Cuánto vive una imagen pegada.
const KEEP_FOR: Duration = Duration::from_secs(15 * 24 * 60 * 60);

/// Extensión según la **firma** (no según lo que diga el webview).
pub fn extension_of(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]) {
        Some("png")
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("jpg")
    } else if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("webp")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("gif")
    } else {
        None
    }
}

/// Valida, purga lo caducado y escribe `<ms>-<12 hex de sha256>.<ext>` en `dir`
/// de forma atómica (temporal + rename). Devuelve la ruta del fichero.
pub fn save_in(dir: &Path, bytes: &[u8], now: SystemTime) -> Result<PathBuf, String> {
    if bytes.is_empty() {
        return Err("La imagen está vacía.".into());
    }
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err("La imagen pesa más de 5 MB.".into());
    }
    let ext = extension_of(bytes)
        .ok_or_else(|| "Formato de imagen no admitido (PNG, JPEG, WebP o GIF).".to_string())?;
    fs::create_dir_all(dir).map_err(|e| format!("No se pudo crear la carpeta de imágenes: {e}"))?;
    purge(dir, now);
    let digest = Sha256::digest(bytes);
    let hex: String = digest.iter().take(6).map(|b| format!("{b:02x}")).collect();
    let millis = now
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let name = format!("{millis}-{hex}.{ext}");
    let target = dir.join(&name);
    let tmp = dir.join(format!(".{name}.tmp"));
    fs::write(&tmp, bytes).map_err(|e| format!("No se pudo guardar la imagen: {e}"))?;
    fs::rename(&tmp, &target).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("No se pudo guardar la imagen: {e}")
    })?;
    Ok(target)
}

/// Borra los ficheros de `dir` con más de 15 días. Un fallo aquí no es un error
/// del guardado.
fn purge(dir: &Path, now: SystemTime) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(meta) = entry.metadata() else { continue };
        if !meta.is_file() {
            continue;
        }
        let old = meta
            .modified()
            .ok()
            .and_then(|m| now.duration_since(m).ok())
            .is_some_and(|age| age > KEEP_FOR);
        if old {
            let _ = fs::remove_file(entry.path());
        }
    }
}

/// `<home>/.stratum/images`.
pub fn images_dir(home: &Path) -> PathBuf {
    home.join(".stratum").join("images")
}

#[cfg(test)]
mod tests {
    use super::*;

    const PNG: [u8; 12] = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0];

    #[test]
    fn reconoce_las_cuatro_firmas() {
        assert_eq!(extension_of(&PNG), Some("png"));
        assert_eq!(extension_of(&[0xFF, 0xD8, 0xFF, 0xE0]), Some("jpg"));
        assert_eq!(extension_of(b"RIFF\0\0\0\0WEBPVP8 "), Some("webp"));
        assert_eq!(extension_of(b"GIF89a\0\0"), Some("gif"));
        assert_eq!(extension_of(b"RIFF\0\0\0\0WAVEfmt "), None);
        assert_eq!(extension_of(b"no soy una imagen"), None);
    }

    #[test]
    fn guarda_con_nombre_estable_y_extension_de_la_firma() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = images_dir(tmp.path());
        let now = UNIX_EPOCH + Duration::from_millis(1_700_000_000_123);
        let path = save_in(&dir, &PNG, now).unwrap();
        let name = path.file_name().unwrap().to_str().unwrap();
        let (stem, ext) = name.rsplit_once('.').unwrap();
        assert_eq!(ext, "png");
        let (ms, hex) = stem.split_once('-').unwrap();
        assert_eq!(ms, "1700000000123");
        assert_eq!(hex.len(), 12);
        assert!(hex.chars().all(|c| c.is_ascii_hexdigit()));
        assert_eq!(fs::read(&path).unwrap(), PNG);
        // Ningún temporal se queda.
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
    }

    #[test]
    fn rechaza_firma_invalida_vacio_y_grande() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = images_dir(tmp.path());
        assert!(save_in(&dir, b"texto", SystemTime::now()).is_err());
        assert!(save_in(&dir, &[], SystemTime::now()).is_err());
        let mut big = PNG.to_vec();
        big.resize(MAX_IMAGE_BYTES + 1, 0);
        assert!(save_in(&dir, &big, SystemTime::now()).is_err());
        // Justo en el tope sí cabe.
        big.truncate(MAX_IMAGE_BYTES);
        assert!(save_in(&dir, &big, SystemTime::now()).is_ok());
    }

    #[test]
    fn purga_lo_de_mas_de_quince_dias() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = images_dir(tmp.path());
        fs::create_dir_all(&dir).unwrap();
        let now = SystemTime::now();
        let old = dir.join("viejo.png");
        let recent = dir.join("reciente.png");
        fs::write(&old, PNG).unwrap();
        fs::write(&recent, PNG).unwrap();
        fs::File::options()
            .write(true)
            .open(&old)
            .unwrap()
            .set_modified(now - Duration::from_secs(16 * 24 * 60 * 60))
            .unwrap();
        fs::File::options()
            .write(true)
            .open(&recent)
            .unwrap()
            .set_modified(now - Duration::from_secs(14 * 24 * 60 * 60))
            .unwrap();
        save_in(&dir, &PNG, now).unwrap();
        assert!(!old.exists());
        assert!(recent.exists());
    }
}
