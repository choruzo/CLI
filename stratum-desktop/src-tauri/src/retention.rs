//! Retención de las carpetas de conversación (D3, reimplementada tras M12).
//!
//! Cada conversación del asistente vive en `<root>/<uuid>/`. Con el tiempo sin
//! uso pasa por tres estados, que se reconocen **solo por lo que hay en disco**
//! (no hay registro que se pueda desincronizar):
//!
//! | Estado     | En disco                    | Cuándo                                  |
//! |------------|-----------------------------|-----------------------------------------|
//! | `active`   | `<uuid>/`                   | uso reciente                            |
//! | `archived` | `<uuid>.tar.gz`             | sin uso ≥ `compressAfterDays`           |
//! | `purged`   | `<uuid>.purged` (vacío)     | sin uso ≥ `deleteAfterDays`             |
//!
//! `0` desactiva cada etapa. Una carpeta que ya pasó `deleteAfterDays` se purga
//! sin comprimirla antes. La conversación en sí es del daemon y no se toca:
//! solo se retiran sus ficheros.
//!
//! **Último uso** de una carpeta = la fecha de modificación más reciente de
//! cualquier cosa dentro (recursivo, sin seguir enlaces), incluido el marcador
//! `.last-used`, que Desktop escribe al crearla, al adjuntar, al restaurar y
//! antes de cada mensaje ([`touch_use`]). Así una conversación en la que solo se
//! charla (sin ficheros nuevos) también cuenta como en uso. Abrirla para mirarla
//! no cuenta. De una carpeta archivada, la fecha de modificación del `.tar.gz`
//! **es** el último uso de la carpeta que contenía.
//!
//! Garantías:
//! - Se archiva a `.retention-<id>.tar.gz.part`, se **verifica** (se relee y se
//!   compara cada fichero por sha256 con lo que se escribió), y solo entonces se
//!   renombra a su nombre final y se retira la carpeta (renombrándola antes a
//!   `.retention-trash-<id>`: si un proceso la tiene abierta, falla y la carpeta
//!   se queda, que gana sobre un archivo obsoleto). Si la carpeta cambió mientras
//!   se archivaba, se descarta el archivo.
//! - Se archivan ficheros y directorios; los enlaces simbólicos y demás tipos se
//!   omiten (el agente está confinado a `outputs/` y `scratch/` y no los crea).
//! - Restaurar extrae a `.retention-restore-<id>` y renombra. La extracción
//!   confina cada entrada: solo ficheros y directorios, con componentes normales
//!   (nada de `..`, rutas absolutas, `:` ni `\`), sin sobrescribir y con tope de
//!   bytes y de entradas. Cualquier entrada rara aborta **toda** la restauración
//!   (el archivo se queda donde estaba).
//! - Comprimir, purgar y restaurar de una misma raíz se serializan con un cerrojo
//!   (`gate`); cada decisión se vuelve a tomar con el cerrojo cogido, de modo
//!   que una conversación que se usa mientras corre el barrido no se toca.

use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::workspace::{is_uuid, INPUTS, OUTPUTS, SCRATCH};

/// Defaults (los del schema de `stratum-cli/src/config/schema.ts`): comprimir a
/// la semana y eliminar a los 5 meses.
pub const DEFAULT_COMPRESS_DAYS: f64 = 7.0;
pub const DEFAULT_DELETE_DAYS: f64 = 150.0;

/// Marcador de uso, en la raíz de la carpeta.
pub const USE_MARKER: &str = ".last-used";
/// Todo lo temporal que crea este módulo empieza así (y se barre si queda).
const TEMP_PREFIX: &str = ".retention-";
/// Un temporal huérfano más viejo que esto se borra.
const STALE_TEMP: Duration = Duration::from_secs(24 * 3600);
/// Entradas que se miran como mucho al medir el último uso.
const MAX_WALK: usize = 200_000;
/// Topes de una restauración (un archivo malicioso o corrupto no llena el disco).
const RESTORE_MAX_BYTES: u64 = 16 * 1024 * 1024 * 1024;
const RESTORE_MAX_ENTRIES: usize = 500_000;

/// `desktop.workspaces.{compressAfterDays,deleteAfterDays}`; `0` = etapa desactivada.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Retention {
    pub compress_after_days: f64,
    pub delete_after_days: f64,
}

impl Default for Retention {
    fn default() -> Self {
        Self {
            compress_after_days: DEFAULT_COMPRESS_DAYS,
            delete_after_days: DEFAULT_DELETE_DAYS,
        }
    }
}

impl Retention {
    pub fn compress_after(&self) -> Option<Duration> {
        days(self.compress_after_days)
    }

    pub fn delete_after(&self) -> Option<Duration> {
        days(self.delete_after_days)
    }
}

fn days(d: f64) -> Option<Duration> {
    (d.is_finite() && d > 0.0).then(|| Duration::from_secs_f64(d * 86_400.0))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum FolderState {
    /// Carpeta completa.
    Active,
    /// Solo el `.tar.gz`.
    Archived,
    /// Eliminada por antigüedad: solo queda la marca.
    Purged,
    /// Sin carpeta ni rastro (aún no creada, o borrada a mano).
    Missing,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    Keep,
    Archive,
    Purge,
}

/// Qué hacer con una carpeta en `state` que lleva `age` sin uso. Pura.
///
/// Si ya pasó `deleteAfterDays` se purga **sin comprimir antes**, también cuando
/// la configuración es incoherente (`deleteAfterDays ≤ compressAfterDays`).
pub fn decide(state: FolderState, age: Duration, retention: &Retention) -> Action {
    let purge = retention.delete_after().is_some_and(|d| age >= d);
    match state {
        FolderState::Active if purge => Action::Purge,
        FolderState::Active if retention.compress_after().is_some_and(|d| age >= d) => {
            Action::Archive
        }
        FolderState::Archived if purge => Action::Purge,
        _ => Action::Keep,
    }
}

pub fn archive_path(root: &Path, id: &str) -> PathBuf {
    root.join(format!("{id}.tar.gz"))
}

pub fn tombstone_path(root: &Path, id: &str) -> PathBuf {
    root.join(format!("{id}.purged"))
}

fn is_real_dir(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|m| m.is_dir())
}

fn is_real_file(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|m| m.is_file())
}

/// Estado de la carpeta de `id`, según lo que hay en `root`.
pub fn folder_state(root: &Path, id: &str) -> FolderState {
    if is_real_dir(&root.join(id)) {
        FolderState::Active
    } else if is_real_file(&archive_path(root, id)) {
        FolderState::Archived
    } else if is_real_file(&tombstone_path(root, id)) {
        FolderState::Purged
    } else {
        FolderState::Missing
    }
}

/// Escribe el marcador de uso (contenido distinto cada vez: su fecha de
/// modificación cambia en cualquier sistema de ficheros).
pub fn touch_use(dir: &Path) -> io::Result<()> {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    fs::write(dir.join(USE_MARKER), stamp.to_string())
}

/// Último uso de una carpeta activa: la fecha de modificación más reciente de
/// cualquier entrada (recursivo, sin seguir enlaces). `None` si no se puede
/// leer la propia carpeta: no se decide nada sobre lo que no se puede medir.
pub fn last_used(dir: &Path) -> Option<SystemTime> {
    let mut newest = fs::symlink_metadata(dir).ok()?.modified().ok()?;
    let mut budget = MAX_WALK;
    walk_newest(dir, &mut newest, &mut budget);
    Some(newest)
}

fn walk_newest(dir: &Path, newest: &mut SystemTime, budget: &mut usize) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        if *budget == 0 {
            return;
        }
        *budget -= 1;
        let Ok(meta) = fs::symlink_metadata(entry.path()) else {
            continue;
        };
        if let Ok(modified) = meta.modified() {
            if modified > *newest {
                *newest = modified;
            }
        }
        if meta.is_dir() {
            walk_newest(&entry.path(), newest, budget);
        }
    }
}

fn lock(gate: &Mutex<()>) -> MutexGuard<'_, ()> {
    // Un pánico en otro hilo no deja el cerrojo inservible: no guarda estado.
    gate.lock().unwrap_or_else(|e| e.into_inner())
}

fn secs(t: SystemTime) -> u64 {
    t.duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Archivar
// ---------------------------------------------------------------------------

/// Un elemento de la carpeta tal como se archivó.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Item {
    is_dir: bool,
    size: u64,
    sha256: Vec<u8>,
}

/// Lee y calcula el sha256 de lo que pasa por él.
struct Hashing<R> {
    inner: R,
    hasher: Sha256,
    read: u64,
}

impl<R: Read> Read for Hashing<R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let n = self.inner.read(buf)?;
        self.hasher.update(&buf[..n]);
        self.read += n as u64;
        Ok(n)
    }
}

struct Source {
    rel: String,
    path: PathBuf,
    is_dir: bool,
}

fn collect(dir: &Path, prefix: &str, out: &mut Vec<Source>) -> Result<(), String> {
    let mut entries: Vec<_> = fs::read_dir(dir)
        .map_err(|e| format!("no se pudo leer {}: {e}", dir.display()))?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| "un nombre de fichero no es texto válido".to_string())?;
        let rel = if prefix.is_empty() {
            name
        } else {
            format!("{prefix}/{name}")
        };
        let meta = fs::symlink_metadata(entry.path()).map_err(|e| e.to_string())?;
        if meta.is_dir() {
            out.push(Source {
                rel: rel.clone(),
                path: entry.path(),
                is_dir: true,
            });
            collect(&entry.path(), &rel, out)?;
        } else if meta.is_file() {
            out.push(Source {
                rel,
                path: entry.path(),
                is_dir: false,
            });
        }
        // Enlaces y demás: no se archivan.
    }
    Ok(())
}

/// Escribe `dir` como `.tar.gz` en `part` y devuelve lo que metió.
fn write_archive(dir: &Path, part: &Path) -> Result<BTreeMap<String, Item>, String> {
    let mut sources = Vec::new();
    collect(dir, "", &mut sources)?;
    let file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(part)
        .map_err(|e| format!("no se pudo crear el archivo: {e}"))?;
    let gz = flate2::write::GzEncoder::new(file, flate2::Compression::default());
    let mut builder = tar::Builder::new(gz);
    let mut manifest = BTreeMap::new();
    for source in &sources {
        let meta = fs::symlink_metadata(&source.path).map_err(|e| e.to_string())?;
        let mut header = tar::Header::new_gnu();
        header.set_mtime(meta.modified().map(secs).unwrap_or(0));
        if source.is_dir {
            header.set_entry_type(tar::EntryType::Directory);
            header.set_size(0);
            header.set_mode(0o755);
            builder
                .append_data(&mut header, format!("{}/", source.rel), io::empty())
                .map_err(|e| format!("no se pudo archivar {}: {e}", source.rel))?;
            manifest.insert(
                source.rel.clone(),
                Item {
                    is_dir: true,
                    size: 0,
                    sha256: Vec::new(),
                },
            );
            continue;
        }
        let size = meta.len();
        header.set_entry_type(tar::EntryType::Regular);
        header.set_size(size);
        header.set_mode(0o644);
        let input = fs::File::open(&source.path)
            .map_err(|e| format!("no se puede leer {}: {e}", source.rel))?;
        let mut reader = Hashing {
            inner: input.take(size),
            hasher: Sha256::new(),
            read: 0,
        };
        builder
            .append_data(&mut header, &source.rel, &mut reader)
            .map_err(|e| format!("no se pudo archivar {}: {e}", source.rel))?;
        if reader.read != size {
            return Err(format!("{} cambió mientras se archivaba", source.rel));
        }
        manifest.insert(
            source.rel.clone(),
            Item {
                is_dir: false,
                size,
                sha256: reader.hasher.finalize().to_vec(),
            },
        );
    }
    let gz = builder
        .into_inner()
        .map_err(|e| format!("no se pudo cerrar el archivo: {e}"))?;
    let file = gz
        .finish()
        .map_err(|e| format!("no se pudo cerrar el archivo: {e}"))?;
    file.sync_all().map_err(|e| e.to_string())?;
    Ok(manifest)
}

/// Relee el archivo y comprueba que contiene exactamente `manifest`.
fn verify_archive(part: &Path, manifest: &BTreeMap<String, Item>) -> Result<(), String> {
    let file = fs::File::open(part).map_err(|e| format!("no se pudo verificar: {e}"))?;
    let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(file));
    let mut seen: HashSet<String> = HashSet::new();
    let bad = |what: &str| format!("el archivo no coincide con la carpeta ({what})");
    for entry in archive.entries().map_err(|e| e.to_string())? {
        let mut entry = entry.map_err(|e| format!("archivo ilegible: {e}"))?;
        let path = String::from_utf8(entry.path_bytes().into_owned())
            .map_err(|_| bad("nombre no válido"))?;
        let path = path.trim_end_matches('/').to_string();
        let expected = manifest.get(&path).ok_or_else(|| bad(&path))?;
        if !seen.insert(path.clone()) {
            return Err(bad(&format!("{path} repetido")));
        }
        let is_dir = entry.header().entry_type().is_dir();
        if is_dir != expected.is_dir {
            return Err(bad(&path));
        }
        if is_dir {
            continue;
        }
        let mut hasher = Sha256::new();
        let mut buf = [0u8; 64 * 1024];
        let mut total = 0u64;
        loop {
            let n = entry
                .read(&mut buf)
                .map_err(|e| format!("archivo ilegible: {e}"))?;
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
            total += n as u64;
        }
        if total != expected.size || hasher.finalize().to_vec() != expected.sha256 {
            return Err(bad(&path));
        }
    }
    if seen.len() != manifest.len() {
        return Err(bad("faltan entradas"));
    }
    Ok(())
}

fn set_modified(path: &Path, time: SystemTime) -> io::Result<()> {
    fs::OpenOptions::new()
        .write(true)
        .open(path)?
        .set_modified(time)
}

/// Retira una carpeta: la renombra a un nombre temporal (atómico; falla si
/// alguien la tiene abierta) y la borra. Si el borrado falla a medias, el
/// resto se barre en el siguiente pase.
fn remove_folder(root: &Path, id: &str, dir: &Path) -> Result<(), String> {
    let trash = root.join(format!("{TEMP_PREFIX}trash-{id}"));
    if fs::symlink_metadata(&trash).is_ok() {
        let _ = fs::remove_dir_all(&trash);
    }
    fs::rename(dir, &trash).map_err(|e| format!("no se pudo retirar la carpeta: {e}"))?;
    let _ = fs::remove_dir_all(&trash);
    Ok(())
}

/// Archiva `<root>/<id>/` en `<root>/<id>.tar.gz`. Llamar con el cerrojo cogido.
fn archive_folder(root: &Path, id: &str) -> Result<(), String> {
    let dir = root.join(id);
    let before = last_used(&dir).ok_or("no se pudo medir el último uso")?;
    let part = root.join(format!("{TEMP_PREFIX}{id}.tar.gz.part"));
    let _ = fs::remove_file(&part);
    let built = write_archive(&dir, &part)
        .and_then(|manifest| verify_archive(&part, &manifest))
        .and_then(|()| set_modified(&part, before).map_err(|e| e.to_string()));
    if let Err(e) = built {
        let _ = fs::remove_file(&part);
        return Err(e);
    }
    // Si se usó mientras se archivaba, este archivo ya no la representa.
    if last_used(&dir) != Some(before) {
        let _ = fs::remove_file(&part);
        return Err("la carpeta se usó mientras se archivaba".into());
    }
    if let Err(e) = fs::rename(&part, archive_path(root, id)) {
        let _ = fs::remove_file(&part);
        return Err(format!("no se pudo guardar el archivo: {e}"));
    }
    // El archivo ya es firme. Si la carpeta no se deja retirar se queda (gana
    // sobre el archivo y el siguiente pase lo rehace).
    remove_folder(root, id, &dir)
}

/// Elimina los ficheros de `id` y deja la marca `.purged`. La marca va primero:
/// desde ahí la purga es firme aunque el borrado se interrumpa.
fn purge_folder(root: &Path, id: &str) -> Result<(), String> {
    let tombstone = tombstone_path(root, id);
    let tmp = root.join(format!("{TEMP_PREFIX}{id}.purged.part"));
    fs::write(&tmp, format!("{}\n", secs(SystemTime::now())))
        .and_then(|()| fs::rename(&tmp, &tombstone))
        .map_err(|e| {
            let _ = fs::remove_file(&tmp);
            format!("no se pudo marcar como eliminada: {e}")
        })?;
    let dir = root.join(id);
    if is_real_dir(&dir) {
        remove_folder(root, id, &dir)?;
    }
    let archive = archive_path(root, id);
    if fs::symlink_metadata(&archive).is_ok() {
        fs::remove_file(&archive).map_err(|e| format!("no se pudo borrar el archivo: {e}"))?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Restaurar
// ---------------------------------------------------------------------------

/// Extrae un `.tar.gz` en `dest` (que no existe todavía) confinando cada
/// entrada. Cualquier entrada que no sea un fichero o un directorio normal
/// dentro de `dest` aborta todo.
pub fn extract_confined<R: Read>(
    reader: R,
    dest: &Path,
    max_bytes: u64,
    max_entries: usize,
) -> Result<(), String> {
    fs::create_dir(dest).map_err(|e| format!("no se pudo preparar la restauración: {e}"))?;
    let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(reader));
    let mut total = 0u64;
    let mut count = 0usize;
    for entry in archive
        .entries()
        .map_err(|e| format!("archivo ilegible: {e}"))?
    {
        let mut entry = entry.map_err(|e| format!("archivo ilegible: {e}"))?;
        count += 1;
        if count > max_entries {
            return Err("el archivo tiene demasiadas entradas".into());
        }
        let raw = entry.path_bytes().into_owned();
        let rel = confined_name(&raw)?;
        let kind = entry.header().entry_type();
        let target = rel.iter().fold(dest.to_path_buf(), |p, part| p.join(part));
        if kind.is_dir() {
            fs::create_dir_all(&target)
                .map_err(|e| format!("no se pudo crear {}: {e}", rel.join("/")))?;
        } else if kind.is_file() {
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent)
                    .map_err(|e| format!("no se pudo crear {}: {e}", rel.join("/")))?;
            }
            let mut out = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&target)
                .map_err(|e| format!("no se pudo crear {}: {e}", rel.join("/")))?;
            let left = max_bytes.saturating_sub(total);
            let copied = io::copy(&mut (&mut entry).take(left + 1), &mut out)
                .map_err(|e| format!("error al restaurar {}: {e}", rel.join("/")))?;
            total += copied;
            if total > max_bytes {
                return Err("el archivo es demasiado grande para restaurarlo".into());
            }
            out.flush().map_err(|e| e.to_string())?;
        } else {
            return Err(format!(
                "entrada no permitida en el archivo ({}): solo ficheros y directorios",
                rel.join("/")
            ));
        }
    }
    Ok(())
}

/// Componentes de una ruta del archivo, o error si no es un nombre confinado:
/// UTF-8, relativa, sin `.`/`..`/vacíos, y sin `:` ni `\` (en Windows serían
/// una unidad, un flujo alterno o un separador).
fn confined_name(raw: &[u8]) -> Result<Vec<String>, String> {
    let bad = || "ruta no permitida en el archivo".to_string();
    let text = std::str::from_utf8(raw).map_err(|_| bad())?;
    if text.contains(['\\', ':', '\0']) {
        return Err(bad());
    }
    let text = text.strip_suffix('/').unwrap_or(text);
    if text.is_empty() {
        return Err(bad());
    }
    let parts: Vec<&str> = text.split('/').collect();
    if parts
        .iter()
        .any(|p| p.is_empty() || *p == "." || *p == "..")
    {
        return Err(bad());
    }
    Ok(parts.into_iter().map(str::to_string).collect())
}

/// Las tres carpetas de siempre, por si el archivo no las traía.
fn ensure_subdirs(dir: &Path) -> io::Result<()> {
    for sub in [INPUTS, OUTPUTS, SCRATCH] {
        let path = dir.join(sub);
        if !path.is_dir() {
            fs::create_dir(&path)?;
        }
    }
    Ok(())
}

fn restore_folder(root: &Path, id: &str) -> Result<(), String> {
    let archive = archive_path(root, id);
    let tmp = root.join(format!("{TEMP_PREFIX}restore-{id}"));
    if fs::symlink_metadata(&tmp).is_ok() {
        fs::remove_dir_all(&tmp).map_err(|e| format!("no se pudo limpiar la restauración: {e}"))?;
    }
    let file = fs::File::open(&archive).map_err(|e| format!("no se pudo abrir el archivo: {e}"))?;
    let done = extract_confined(file, &tmp, RESTORE_MAX_BYTES, RESTORE_MAX_ENTRIES)
        .and_then(|()| ensure_subdirs(&tmp).map_err(|e| e.to_string()))
        .and_then(|()| touch_use(&tmp).map_err(|e| e.to_string()));
    if let Err(e) = done {
        let _ = fs::remove_dir_all(&tmp);
        return Err(format!("no se pudo restaurar los ficheros: {e}"));
    }
    let dir = root.join(id);
    if let Err(e) = fs::rename(&tmp, &dir) {
        let _ = fs::remove_dir_all(&tmp);
        return Err(format!("no se pudo restaurar los ficheros: {e}"));
    }
    // Restaurada: el archivo ya no hace falta (si no se deja borrar, la
    // carpeta gana y el siguiente archivado lo sustituye).
    let _ = fs::remove_file(&archive);
    Ok(())
}

/// Deja la carpeta de `id` lista para trabajar, y la marca como en uso:
/// - `active`: solo marca el uso.
/// - `archived`: la restaura desde su `.tar.gz`.
/// - `purged` / `missing`: crea una vacía (la sesión necesita su directorio) y
///   retira la marca de eliminada.
///
/// Devuelve el estado **anterior**, para que la interfaz sepa qué ocurrió.
pub fn ensure(root: &Path, id: &str, gate: &Mutex<()>) -> Result<FolderState, String> {
    if !is_uuid(id) {
        return Err("identificador de conversación no válido".into());
    }
    let _guard = lock(gate);
    let previous = folder_state(root, id);
    let dir = root.join(id);
    match previous {
        FolderState::Active => {}
        FolderState::Archived => restore_folder(root, id)?,
        FolderState::Purged | FolderState::Missing => {
            fs::create_dir_all(root).map_err(|e| format!("no se pudo crear la carpeta: {e}"))?;
            fs::create_dir(&dir)
                .and_then(|()| ensure_subdirs(&dir))
                .map_err(|e| format!("no se pudo crear la carpeta: {e}"))?;
        }
    }
    touch_use(&dir).map_err(|e| format!("no se pudo marcar el uso: {e}"))?;
    let _ = fs::remove_file(tombstone_path(root, id));
    Ok(previous)
}

// ---------------------------------------------------------------------------
// Barrido
// ---------------------------------------------------------------------------

#[derive(Debug, Default, PartialEq)]
pub struct SweepReport {
    pub archived: Vec<String>,
    pub purged: Vec<String>,
    /// `(id, motivo)` de lo que no se pudo hacer; se reintenta en el siguiente pase.
    pub failed: Vec<(String, String)>,
}

/// Ids de conversación que hay en `root` (carpeta, archivo o marca).
fn ids_in(root: &Path) -> Vec<String> {
    let Ok(entries) = fs::read_dir(root) else {
        return Vec::new();
    };
    let mut ids: Vec<String> = entries
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().into_string().ok()?;
            let id = name
                .strip_suffix(".tar.gz")
                .or_else(|| name.strip_suffix(".purged"))
                .unwrap_or(&name);
            is_uuid(id).then(|| id.to_string())
        })
        .collect();
    ids.sort();
    ids.dedup();
    ids
}

/// Borra los temporales huérfanos de un pase anterior (más viejos que un día).
fn sweep_stale_temps(root: &Path, now: SystemTime) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        if !entry.file_name().to_string_lossy().starts_with(TEMP_PREFIX) {
            continue;
        }
        let path = entry.path();
        let Ok(meta) = fs::symlink_metadata(&path) else {
            continue;
        };
        let old = meta
            .modified()
            .ok()
            .and_then(|m| now.duration_since(m).ok())
            .is_some_and(|age| age >= STALE_TEMP);
        if old {
            if meta.is_dir() {
                let _ = fs::remove_dir_all(&path);
            } else {
                let _ = fs::remove_file(&path);
            }
        }
    }
}

/// Un pase de retención sobre `root`. `now` se inyecta para poder probarlo.
/// Cada conversación se decide y se aplica con el cerrojo cogido, midiendo su
/// último uso en ese momento: lo que se acaba de usar se deja como está.
pub fn sweep(root: &Path, retention: &Retention, now: SystemTime, gate: &Mutex<()>) -> SweepReport {
    let mut report = SweepReport::default();
    if retention.compress_after().is_none() && retention.delete_after().is_none() {
        return report;
    }
    sweep_stale_temps(root, now);
    for id in ids_in(root) {
        let _guard = lock(gate);
        let state = folder_state(root, &id);
        let last = match state {
            FolderState::Active => last_used(&root.join(&id)),
            FolderState::Archived => fs::metadata(archive_path(root, &id))
                .and_then(|m| m.modified())
                .ok(),
            FolderState::Purged | FolderState::Missing => continue,
        };
        // Sin fecha legible no se decide; una fecha futura cuenta como uso ahora.
        let Some(last) = last else {
            report
                .failed
                .push((id, "no se pudo medir el último uso".into()));
            continue;
        };
        let age = now.duration_since(last).unwrap_or(Duration::ZERO);
        match decide(state, age, retention) {
            Action::Keep => {}
            Action::Archive => match archive_folder(root, &id) {
                Ok(()) => report.archived.push(id),
                Err(e) => report.failed.push((id, e)),
            },
            Action::Purge => match purge_folder(root, &id) {
                Ok(()) => report.purged.push(id),
                Err(e) => report.failed.push((id, e)),
            },
        }
    }
    report
}

#[cfg(test)]
mod tests {
    use super::*;

    const A: &str = "0b5b2c7e-5c1a-4f7e-8d3a-000000000001";
    const B: &str = "0b5b2c7e-5c1a-4f7e-8d3a-000000000002";
    const DAY: Duration = Duration::from_secs(86_400);

    fn r(compress: f64, delete: f64) -> Retention {
        Retention {
            compress_after_days: compress,
            delete_after_days: delete,
        }
    }

    fn days_after_now(n: u64) -> SystemTime {
        SystemTime::now() + DAY * n as u32
    }

    fn folder(root: &Path, id: &str) -> PathBuf {
        let dir = root.join(id);
        for sub in [INPUTS, OUTPUTS, SCRATCH] {
            fs::create_dir_all(dir.join(sub)).unwrap();
        }
        fs::write(dir.join("inputs/datos ñ.csv"), "a,b\n1,2\n").unwrap();
        fs::create_dir_all(dir.join("outputs/sub/hondo")).unwrap();
        fs::write(dir.join("outputs/sub/informe.md"), "# hola".repeat(1000)).unwrap();
        fs::write(dir.join("outputs/vacio.txt"), "").unwrap();
        touch_use(&dir).unwrap();
        dir
    }

    fn gz(entries: &[(&[u8], tar::EntryType, &[u8], Option<&str>)]) -> Vec<u8> {
        let mut builder = tar::Builder::new(Vec::new());
        for (name, kind, data, link) in entries {
            let mut h = tar::Header::new_gnu();
            h.as_old_mut().name[..name.len()].copy_from_slice(name);
            h.set_entry_type(*kind);
            h.set_size(data.len() as u64);
            h.set_mode(0o644);
            if let Some(l) = link {
                h.as_old_mut().linkname[..l.len()].copy_from_slice(l.as_bytes());
            }
            h.set_cksum();
            builder.append(&h, *data).unwrap();
        }
        let tarball = builder.into_inner().unwrap();
        let mut enc = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        enc.write_all(&tarball).unwrap();
        enc.finish().unwrap()
    }

    #[test]
    fn decide_por_edades() {
        let ret = r(7.0, 150.0);
        let d = |s, days: u64| decide(s, DAY * days as u32, &ret);
        assert_eq!(d(FolderState::Active, 6), Action::Keep);
        assert_eq!(d(FolderState::Active, 7), Action::Archive);
        assert_eq!(d(FolderState::Active, 149), Action::Archive);
        assert_eq!(d(FolderState::Active, 150), Action::Purge);
        assert_eq!(d(FolderState::Archived, 7), Action::Keep);
        assert_eq!(d(FolderState::Archived, 150), Action::Purge);
        assert_eq!(d(FolderState::Purged, 9999), Action::Keep);
        assert_eq!(d(FolderState::Missing, 9999), Action::Keep);
    }

    #[test]
    fn cero_desactiva_cada_etapa() {
        let old = DAY * 10_000;
        assert_eq!(decide(FolderState::Active, old, &r(0.0, 0.0)), Action::Keep);
        assert_eq!(
            decide(FolderState::Active, old, &r(0.0, 5.0)),
            Action::Purge
        );
        assert_eq!(
            decide(FolderState::Active, old, &r(7.0, 0.0)),
            Action::Archive
        );
        assert_eq!(
            decide(FolderState::Archived, old, &r(7.0, 0.0)),
            Action::Keep
        );
        assert_eq!(
            decide(FolderState::Active, DAY * 3, &r(0.0, 5.0)),
            Action::Keep
        );
    }

    #[test]
    fn una_config_incoherente_purga_sin_comprimir() {
        // deleteAfter ≤ compressAfter: nunca se comprime lo que ya toca eliminar.
        let ret = r(10.0, 5.0);
        assert_eq!(decide(FolderState::Active, DAY * 6, &ret), Action::Purge);
        assert_eq!(decide(FolderState::Active, DAY * 4, &ret), Action::Keep);
        assert_eq!(decide(FolderState::Active, DAY * 10, &ret), Action::Purge);
        let same = r(7.0, 7.0);
        assert_eq!(decide(FolderState::Active, DAY * 7, &same), Action::Purge);
    }

    #[test]
    fn los_defaults_son_siete_dias_y_cinco_meses() {
        let d = Retention::default();
        assert_eq!(d.compress_after(), Some(DAY * 7));
        assert_eq!(d.delete_after(), Some(DAY * 150));
        assert_eq!(r(0.0, 0.0).compress_after(), None);
        assert_eq!(r(f64::NAN, -1.0).delete_after(), None);
    }

    #[test]
    fn ultimo_uso_es_lo_mas_reciente_de_dentro() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = folder(tmp.path(), A);
        let used = last_used(&dir).unwrap();
        assert!(used.elapsed().unwrap() < Duration::from_secs(60));
        assert!(last_used(&tmp.path().join("no-existe")).is_none());
        // Un fichero nuevo, por hondo que esté, mueve el último uso.
        std::thread::sleep(Duration::from_millis(20));
        fs::write(dir.join("outputs/sub/hondo/nuevo.txt"), "x").unwrap();
        assert!(last_used(&dir).unwrap() > used);
    }

    #[test]
    fn archivar_y_restaurar_ida_y_vuelta() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let dir = folder(root, A);
        let gate = Mutex::new(());
        let before = last_used(&dir).unwrap();
        archive_folder(root, A).unwrap();
        assert_eq!(folder_state(root, A), FolderState::Archived);
        assert!(!dir.exists());
        // El archivo hereda el último uso, y no queda ningún temporal.
        let mtime = fs::metadata(archive_path(root, A))
            .unwrap()
            .modified()
            .unwrap();
        assert_eq!(secs(mtime), secs(before));
        let leftovers: Vec<_> = fs::read_dir(root)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.starts_with(TEMP_PREFIX))
            .collect();
        assert!(leftovers.is_empty(), "{leftovers:?}");

        assert_eq!(ensure(root, A, &gate).unwrap(), FolderState::Archived);
        assert_eq!(folder_state(root, A), FolderState::Active);
        assert!(!archive_path(root, A).exists());
        assert_eq!(
            fs::read_to_string(dir.join("inputs/datos ñ.csv")).unwrap(),
            "a,b\n1,2\n"
        );
        assert_eq!(
            fs::read_to_string(dir.join("outputs/sub/informe.md")).unwrap(),
            "# hola".repeat(1000)
        );
        assert_eq!(fs::read(dir.join("outputs/vacio.txt")).unwrap(), b"");
        assert!(dir.join("outputs/sub/hondo").is_dir());
        assert!(dir.join("scratch").is_dir());
        // Restaurar cuenta como uso.
        assert!(last_used(&dir).unwrap().elapsed().unwrap() < Duration::from_secs(60));
    }

    #[test]
    fn un_fallo_al_archivar_deja_la_carpeta_intacta_y_sin_archivo() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let dir = folder(root, A);
        // El temporal está ocupado por un directorio: no se puede escribir.
        fs::create_dir(root.join(format!("{TEMP_PREFIX}{A}.tar.gz.part"))).unwrap();
        assert!(archive_folder(root, A).is_err());
        assert_eq!(folder_state(root, A), FolderState::Active);
        assert!(dir.join("outputs/sub/informe.md").is_file());
        assert!(!archive_path(root, A).exists());
    }

    #[test]
    fn un_archivo_corrupto_no_pasa_la_verificacion() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = folder(tmp.path(), A);
        let part = tmp.path().join("a.part");
        let manifest = write_archive(&dir, &part).unwrap();
        verify_archive(&part, &manifest).unwrap();
        // Truncado.
        let bytes = fs::read(&part).unwrap();
        fs::write(&part, &bytes[..bytes.len() / 2]).unwrap();
        assert!(verify_archive(&part, &manifest).is_err());
        // Íntegro pero de otra carpeta (el fichero cambió después de medirlo).
        fs::write(dir.join("inputs/datos ñ.csv"), "otro").unwrap();
        let other = tmp.path().join("b.part");
        write_archive(&dir, &other).unwrap();
        assert!(verify_archive(&other, &manifest).is_err());
    }

    #[test]
    fn un_archivo_obsoleto_se_sustituye_de_forma_atomica() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        folder(root, A);
        fs::write(archive_path(root, A), "basura de un intento anterior").unwrap();
        archive_folder(root, A).unwrap();
        assert!(fs::read(archive_path(root, A))
            .unwrap()
            .starts_with(&[0x1f, 0x8b]));
    }

    #[test]
    fn el_barrido_aplica_la_politica() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        folder(root, A);
        folder(root, B);
        let gate = Mutex::new(());
        // Hoy: nada que hacer.
        let rep = sweep(root, &r(7.0, 150.0), SystemTime::now(), &gate);
        assert_eq!(rep, SweepReport::default());
        // A los 10 días: se archivan ambas.
        let rep = sweep(root, &r(7.0, 150.0), days_after_now(10), &gate);
        assert_eq!(rep.archived, vec![A.to_string(), B.to_string()]);
        assert!(rep.failed.is_empty(), "{:?}", rep.failed);
        assert_eq!(folder_state(root, A), FolderState::Archived);
        // A los 160 días: la archivada se purga (queda solo la marca).
        let rep = sweep(root, &r(7.0, 150.0), days_after_now(160), &gate);
        assert_eq!(rep.purged, vec![A.to_string(), B.to_string()]);
        assert_eq!(folder_state(root, A), FolderState::Purged);
        assert!(!archive_path(root, A).exists());
        assert!(!root.join(A).exists());
        // Lo purgado es terminal para el barrido.
        assert_eq!(
            sweep(root, &r(7.0, 150.0), days_after_now(900), &gate),
            SweepReport::default()
        );
    }

    #[test]
    fn una_activa_muy_vieja_se_purga_sin_comprimir() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        folder(root, A);
        let gate = Mutex::new(());
        let rep = sweep(root, &r(7.0, 150.0), days_after_now(200), &gate);
        assert_eq!(rep.purged, vec![A.to_string()]);
        assert!(rep.archived.is_empty());
        assert!(!archive_path(root, A).exists());
        assert_eq!(folder_state(root, A), FolderState::Purged);
    }

    #[test]
    fn con_cero_cada_etapa_se_desactiva() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        folder(root, A);
        let gate = Mutex::new(());
        assert_eq!(
            sweep(root, &r(0.0, 0.0), days_after_now(9000), &gate),
            SweepReport::default()
        );
        assert_eq!(folder_state(root, A), FolderState::Active);
        // Solo comprimir: nunca purga.
        let rep = sweep(root, &r(7.0, 0.0), days_after_now(9000), &gate);
        assert_eq!(rep.archived, vec![A.to_string()]);
        assert_eq!(
            sweep(root, &r(7.0, 0.0), days_after_now(99_000), &gate),
            SweepReport::default()
        );
        assert_eq!(folder_state(root, A), FolderState::Archived);
    }

    #[test]
    fn lo_que_se_acaba_de_usar_no_se_toca() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let dir = folder(root, A);
        let gate = Mutex::new(());
        // Umbral de ~2 s (0,00002 días): sin uso caduca; con uso justo antes, no.
        let quick = r(0.00002, 0.0);
        std::thread::sleep(Duration::from_millis(2500));
        touch_use(&dir).unwrap();
        assert_eq!(
            sweep(root, &quick, SystemTime::now(), &gate),
            SweepReport::default()
        );
        assert_eq!(folder_state(root, A), FolderState::Active);
        std::thread::sleep(Duration::from_millis(2500));
        let rep = sweep(root, &quick, SystemTime::now(), &gate);
        assert_eq!(rep.archived, vec![A.to_string()]);
    }

    #[test]
    fn ensure_crea_una_vacia_si_estaba_eliminada_o_no_estaba() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        folder(root, A);
        let gate = Mutex::new(());
        sweep(root, &r(7.0, 150.0), days_after_now(200), &gate);
        assert_eq!(folder_state(root, A), FolderState::Purged);
        assert_eq!(ensure(root, A, &gate).unwrap(), FolderState::Purged);
        assert_eq!(folder_state(root, A), FolderState::Active);
        assert!(root.join(A).join("outputs").is_dir());
        assert!(!tombstone_path(root, A).exists());
        assert_eq!(
            fs::read_dir(root.join(A).join("outputs")).unwrap().count(),
            0
        );
        assert_eq!(ensure(root, B, &gate).unwrap(), FolderState::Missing);
        assert_eq!(ensure(root, B, &gate).unwrap(), FolderState::Active);
        assert!(ensure(root, "../x", &gate).is_err());
    }

    #[test]
    fn restaurar_rechaza_un_archivo_con_entradas_peligrosas() {
        use tar::EntryType::{Link, Regular, Symlink};
        let cases: Vec<(&str, Vec<u8>)> = vec![
            ("padre", gz(&[(b"../fuera.txt", Regular, b"x", None)])),
            (
                "padre hondo",
                gz(&[(b"a/../../fuera.txt", Regular, b"x", None)]),
            ),
            ("absoluta", gz(&[(b"/tmp/fuera.txt", Regular, b"x", None)])),
            ("unidad", gz(&[(b"C:/fuera.txt", Regular, b"x", None)])),
            (
                "flujo alterno",
                gz(&[(b"inputs/a.txt:zone", Regular, b"x", None)]),
            ),
            (
                "barra invertida",
                gz(&[(b"inputs\\..\\fuera.txt", Regular, b"x", None)]),
            ),
            ("vacio", gz(&[(b"a//b.txt", Regular, b"x", None)])),
            ("punto", gz(&[(b"./a.txt", Regular, b"x", None)])),
            (
                "symlink fuera",
                gz(&[(b"enlace", Symlink, b"", Some("/etc"))]),
            ),
            (
                "symlink relativo",
                gz(&[(b"enlace", Symlink, b"", Some("../../x"))]),
            ),
            ("hardlink", gz(&[(b"dur", Link, b"", Some("../fuera.txt"))])),
            (
                "no utf8",
                gz(&[(&[b'a', 0xff, b'.', b't'], Regular, b"x", None)]),
            ),
        ];
        for (name, bytes) in cases {
            let tmp = tempfile::tempdir().unwrap();
            let dest = tmp.path().join("destino");
            let res = extract_confined(&bytes[..], &dest, 1 << 20, 100);
            assert!(res.is_err(), "{name} debería rechazarse");
            // Nada escapó del destino.
            let names: Vec<_> = fs::read_dir(tmp.path())
                .unwrap()
                .flatten()
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .collect();
            assert_eq!(names, vec!["destino".to_string()], "{name}: {names:?}");
            assert!(!tmp.path().join("fuera.txt").exists(), "{name}");
        }
    }

    #[test]
    fn restaurar_acota_el_tamano_y_las_entradas_y_no_pisa() {
        use tar::EntryType::Regular;
        let big = gz(&[(b"a.bin", Regular, &[7u8; 5000], None)]);
        let tmp = tempfile::tempdir().unwrap();
        assert!(extract_confined(&big[..], &tmp.path().join("d1"), 1000, 10).is_err());
        let many = gz(&[
            (b"a", Regular, b"1", None),
            (b"b", Regular, b"1", None),
            (b"c", Regular, b"1", None),
        ]);
        assert!(extract_confined(&many[..], &tmp.path().join("d2"), 1000, 2).is_err());
        let dup = gz(&[(b"a", Regular, b"1", None), (b"a", Regular, b"2", None)]);
        assert!(extract_confined(&dup[..], &tmp.path().join("d3"), 1000, 10).is_err());
        let ok = gz(&[
            (b"inputs/", tar::EntryType::Directory, b"", None),
            (b"inputs/a.txt", Regular, b"hola", None),
        ]);
        extract_confined(&ok[..], &tmp.path().join("d4"), 1000, 10).unwrap();
        assert_eq!(
            fs::read_to_string(tmp.path().join("d4/inputs/a.txt")).unwrap(),
            "hola"
        );
    }

    #[test]
    fn una_restauracion_fallida_deja_el_archivo_y_no_crea_la_carpeta() {
        use tar::EntryType::Regular;
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        fs::write(
            archive_path(root, A),
            gz(&[(b"../fuera.txt", Regular, b"x", None)]),
        )
        .unwrap();
        let gate = Mutex::new(());
        assert!(ensure(root, A, &gate).is_err());
        assert_eq!(folder_state(root, A), FolderState::Archived);
        assert!(!root.join(A).exists());
        assert!(!root.join(format!("{TEMP_PREFIX}restore-{A}")).exists());
        assert!(!root.join("fuera.txt").exists());
    }

    #[test]
    fn se_barren_los_temporales_viejos_y_solo_los_viejos() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        folder(root, A);
        let stale = root.join(format!("{TEMP_PREFIX}{B}.tar.gz.part"));
        fs::write(&stale, "x").unwrap();
        let gate = Mutex::new(());
        sweep(root, &r(7.0, 150.0), SystemTime::now(), &gate);
        assert!(stale.exists(), "uno reciente puede ser de un pase en curso");
        sweep(root, &r(7.0, 150.0), days_after_now(2), &gate);
        assert!(!stale.exists());
    }

    #[test]
    fn el_barrido_ignora_lo_que_no_es_una_conversacion() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        fs::create_dir(root.join("otra-cosa")).unwrap();
        fs::write(root.join("notas.tar.gz"), "x").unwrap();
        let gate = Mutex::new(());
        let rep = sweep(root, &r(1.0, 2.0), days_after_now(500), &gate);
        assert_eq!(rep, SweepReport::default());
        assert!(root.join("otra-cosa").is_dir());
        assert!(root.join("notas.tar.gz").is_file());
    }
}
