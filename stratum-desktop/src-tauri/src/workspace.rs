//! Ficheros de las conversaciones (D2): subidas a `inputs/`, descargas y vista
//! previa de `outputs/`. Ver `stratum-cli/src/desktop/workspace.ts` para el
//! layout; el sidecar es quien crea el workspace y escribe `.workspace.json`.
//!
//! Reparto de responsabilidades, y por qué:
//! - **El diálogo y el drag & drop los recibe Rust.** Lo que el usuario elige
//!   queda registrado aquí como una *concesión* con un id opaco; el webview solo
//!   ve nombre y tamaño. Así, un fallo de contenido en el webview (un markdown
//!   hostil) no puede pedir que se copie `~/.ssh/id_ed25519` al workspace: solo
//!   puede nombrar concesiones que el usuario hizo a mano.
//! - **Rust copia** al `inputs/` del workspace, con los límites de tamaño
//!   (16.3) comprobados antes de copiar y otra vez durante la copia.
//! - **Las descargas salen solo de `outputs/`**, resueltas por `canonicalize`
//!   contra la carpeta real (ni `..`, ni enlaces), y «Abrir» solo para tipos de
//!   documento inertes: el fichero lo escribió el modelo, y un prompt injection
//!   en un fichero subido podría dejar ahí un `.bat` o un `.html`.
//!
//! La raíz y los límites llegan del sidecar en `handshake_ok.workspaces`.

use serde::Serialize;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{self, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

pub const INPUTS: &str = "inputs";
pub const OUTPUTS: &str = "outputs";

/// Concesiones vivas como mucho (una tanda de drag & drop grande no crece sin fin).
const MAX_GRANTS: usize = 256;
/// Tope de la vista previa de texto.
pub const PREVIEW_TEXT_BYTES: u64 = 512 * 1024;
/// Tope de la vista previa de imagen (viaja al webview como data URL).
pub const PREVIEW_IMAGE_BYTES: u64 = 8 * 1024 * 1024;
/// Longitud máxima de un nombre saneado, en bytes.
const MAX_NAME_BYTES: usize = 150;

/// Extensiones que «Abrir» entrega a la app por defecto del SO: documentos,
/// datos e imágenes inertes. Fuera quedan ejecutables y scripts, pero también
/// `html`/`svg` (se abren en el navegador y ejecutan JavaScript) y los
/// formatos de Office con macros (`docm`, `xlsm`…).
const OPENABLE_EXTENSIONS: &[&str] = &[
    "txt", "md", "markdown", "csv", "tsv", "json", "xml", "yaml", "yml", "log", "pdf", "png",
    "jpg", "jpeg", "gif", "webp", "bmp", "docx", "xlsx", "pptx", "odt", "ods", "odp", "rtf",
];

const TEXT_PREVIEW_EXTENSIONS: &[&str] = &[
    "txt", "md", "markdown", "csv", "tsv", "json", "xml", "yaml", "yml", "log",
];

const IMAGE_PREVIEW_EXTENSIONS: &[(&str, &str)] = &[
    ("png", "image/png"),
    ("jpg", "image/jpeg"),
    ("jpeg", "image/jpeg"),
    ("gif", "image/gif"),
    ("webp", "image/webp"),
    ("bmp", "image/bmp"),
];

#[derive(Debug, Clone, PartialEq)]
pub struct WorkspacesInfo {
    pub root: PathBuf,
    pub max_file_bytes: u64,
    pub max_workspace_bytes: u64,
}

impl WorkspacesInfo {
    /// `handshake_ok.workspaces` del sidecar. `None` si falta o está mal formado
    /// (un sidecar sin D2): entonces no se admiten ficheros.
    pub fn from_handshake(value: &Value) -> Option<Self> {
        let root = value.get("root")?.as_str()?;
        let path = PathBuf::from(root);
        if !path.is_absolute() {
            return None;
        }
        Some(Self {
            root: path,
            max_file_bytes: value.get("maxFileBytes")?.as_u64()?,
            max_workspace_bytes: value.get("maxWorkspaceBytes")?.as_u64()?,
        })
    }

    /// Carpeta del workspace de una conversación. Tiene que existir: la crea el
    /// sidecar al abrir la conversación.
    pub fn conversation_dir(&self, conversation_id: &str) -> Result<PathBuf, String> {
        if !is_uuid(conversation_id) {
            return Err("identificador de conversación no válido".into());
        }
        let dir = self.root.join(conversation_id);
        if !dir.is_dir() {
            return Err("la conversación no tiene carpeta de ficheros (¿está abierta?)".into());
        }
        Ok(dir)
    }
}

/// Mismo criterio que `isConversationId` en el sidecar: UUID en forma canónica.
pub fn is_uuid(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 36
        && b.iter().enumerate().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => *c == b'-',
            _ => c.is_ascii_hexdigit(),
        })
}

/// Lo que ve el webview de un fichero elegido: nunca su ruta.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Candidate {
    pub id: String,
    pub name: String,
    pub size: u64,
    /// Motivo por el que no se puede adjuntar (se muestra antes de copiar nada).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Attached {
    /// Id de la concesión de la que sale.
    pub id: String,
    pub name: String,
    /// Ruta dentro del workspace (`inputs/informe.pdf`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    pub size: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Preview {
    Text { text: String, truncated: bool },
    Image { #[serde(rename = "dataUrl")] data_url: String },
    Unsupported { reason: String },
}

#[derive(Default)]
struct Inner {
    info: Option<WorkspacesInfo>,
    grants: HashMap<String, PathBuf>,
    grant_order: Vec<String>,
    /// Adjuntos copiados que aún no ha llevado ningún `chat`, por conversación:
    /// solo esos se pueden descartar.
    pending: HashMap<String, HashSet<String>>,
}

#[derive(Default)]
pub struct WorkspaceState {
    inner: Mutex<Inner>,
}

impl WorkspaceState {
    pub fn set_info(&self, info: Option<WorkspacesInfo>) {
        self.inner.lock().unwrap().info = info;
    }

    pub fn info(&self) -> Result<WorkspacesInfo, String> {
        self.inner
            .lock()
            .unwrap()
            .info
            .clone()
            .ok_or_else(|| "el agente no está conectado o no admite ficheros".to_string())
    }

    /// Registra lo que el usuario eligió y devuelve lo que puede ver el webview.
    /// Los ficheros que no se pueden adjuntar se informan sin concesión.
    pub fn grant(&self, paths: Vec<PathBuf>) -> Vec<Candidate> {
        let max_file = self.inner.lock().unwrap().info.as_ref().map(|i| i.max_file_bytes);
        let mut out = Vec::with_capacity(paths.len());
        for path in paths {
            let name = path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| "fichero".into());
            let (size, error) = match fs::metadata(&path) {
                Ok(m) if m.is_file() => {
                    let error = max_file
                        .filter(|max| m.len() > *max)
                        .map(|max| format!("supera el límite de {} por fichero", format_bytes(max)));
                    (m.len(), error)
                }
                Ok(_) => (0, Some("solo se pueden adjuntar ficheros, no carpetas".into())),
                Err(e) => (0, Some(format!("no se puede leer: {e}"))),
            };
            let id = if error.is_none() {
                self.insert_grant(path)
            } else {
                random_id()
            };
            out.push(Candidate { id, name, size, error });
        }
        out
    }

    fn insert_grant(&self, path: PathBuf) -> String {
        let id = random_id();
        let mut inner = self.inner.lock().unwrap();
        if inner.grant_order.len() >= MAX_GRANTS {
            let oldest = inner.grant_order.remove(0);
            inner.grants.remove(&oldest);
        }
        inner.grants.insert(id.clone(), path);
        inner.grant_order.push(id.clone());
        id
    }

    /// Copia al workspace las concesiones `ids` (y las consume).
    pub fn attach(&self, conversation_id: &str, ids: &[String]) -> Result<Vec<Attached>, String> {
        let info = self.info()?;
        let dir = info.conversation_dir(conversation_id)?;
        let mut results = Vec::with_capacity(ids.len());
        for id in ids {
            let source = {
                let mut inner = self.inner.lock().unwrap();
                inner.grant_order.retain(|g| g != id);
                inner.grants.remove(id)
            };
            let Some(source) = source else {
                results.push(Attached {
                    id: id.clone(),
                    name: String::new(),
                    path: None,
                    size: 0,
                    error: Some("la selección caducó; vuelve a adjuntar el fichero".into()),
                });
                continue;
            };
            let name = source
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            match copy_into_inputs(&info, &dir, &source) {
                Ok((rel, size)) => {
                    self.inner
                        .lock()
                        .unwrap()
                        .pending
                        .entry(conversation_id.to_string())
                        .or_default()
                        .insert(rel.clone());
                    results.push(Attached {
                        id: id.clone(),
                        name,
                        path: Some(rel),
                        size,
                        error: None,
                    });
                }
                Err(error) => results.push(Attached {
                    id: id.clone(),
                    name,
                    path: None,
                    size: 0,
                    error: Some(error),
                }),
            }
        }
        Ok(results)
    }

    /// Un `chat` se llevó estos adjuntos: ya forman parte de la conversación.
    pub fn commit(&self, conversation_id: &str, paths: &[String]) {
        let mut inner = self.inner.lock().unwrap();
        if let Some(set) = inner.pending.get_mut(conversation_id) {
            for p in paths {
                set.remove(p);
            }
        }
    }

    /// Borra un adjunto que el usuario quitó antes de enviarlo. Solo los
    /// pendientes: lo que ya viajó en un mensaje es parte de la conversación.
    pub fn discard(&self, conversation_id: &str, rel: &str) -> Result<(), String> {
        let info = self.info()?;
        let dir = info.conversation_dir(conversation_id)?;
        let was_pending = self
            .inner
            .lock()
            .unwrap()
            .pending
            .get_mut(conversation_id)
            .map(|s| s.remove(rel))
            .unwrap_or(false);
        if !was_pending {
            return Err("ese fichero ya no se puede quitar".into());
        }
        let path = resolve_in(&dir, INPUTS, rel)?;
        fs::remove_file(&path).map_err(|e| format!("no se pudo borrar: {e}"))
    }

    /// Ruta real de un fichero de `outputs/`, validada.
    pub fn output_path(&self, conversation_id: &str, rel: &str) -> Result<PathBuf, String> {
        let info = self.info()?;
        let dir = info.conversation_dir(conversation_id)?;
        resolve_in(&dir, OUTPUTS, rel)
    }
}

/// Resuelve `rel` (`outputs/x.csv`) dentro de `<dir>/<area>/`: solo componentes
/// normales, fichero regular (no enlace) y `canonicalize` dentro de la carpeta.
pub fn resolve_in(dir: &Path, area: &str, rel: &str) -> Result<PathBuf, String> {
    let bad = || format!("ruta no válida: solo se admiten ficheros de {area}/");
    let rel_path = Path::new(rel);
    let mut components = rel_path.components();
    match components.next() {
        Some(Component::Normal(first)) if first == area => {}
        _ => return Err(bad()),
    }
    let mut rest = 0;
    for c in components {
        match c {
            Component::Normal(part) if !part.to_string_lossy().contains(':') => rest += 1,
            _ => return Err(bad()),
        }
    }
    if rest == 0 {
        return Err(bad());
    }
    let path = dir.join(rel_path);
    let meta = fs::symlink_metadata(&path).map_err(|_| "el fichero ya no existe".to_string())?;
    if !meta.is_file() {
        return Err(bad());
    }
    let base = fs::canonicalize(dir.join(area)).map_err(|e| e.to_string())?;
    let real = fs::canonicalize(&path).map_err(|e| e.to_string())?;
    if !real.starts_with(&base) {
        return Err(bad());
    }
    Ok(real)
}

/// Tamaño de un árbol sin seguir enlaces.
pub fn dir_size(dir: &Path) -> u64 {
    let Ok(entries) = fs::read_dir(dir) else {
        return 0;
    };
    let mut total = 0;
    for entry in entries.flatten() {
        let Ok(meta) = fs::symlink_metadata(entry.path()) else {
            continue;
        };
        if meta.is_dir() {
            total += dir_size(&entry.path());
        } else if meta.is_file() {
            total += meta.len();
        }
    }
    total
}

/// Copia `source` a `<dir>/inputs/` con nombre saneado y sin pisar nada.
/// Devuelve la ruta relativa al workspace y los bytes copiados.
pub fn copy_into_inputs(
    info: &WorkspacesInfo,
    dir: &Path,
    source: &Path,
) -> Result<(String, u64), String> {
    let meta = fs::metadata(source).map_err(|e| format!("no se puede leer: {e}"))?;
    if !meta.is_file() {
        return Err("solo se pueden adjuntar ficheros, no carpetas".into());
    }
    if meta.len() > info.max_file_bytes {
        return Err(format!(
            "supera el límite de {} por fichero",
            format_bytes(info.max_file_bytes)
        ));
    }
    let used = dir_size(dir);
    if used + meta.len() > info.max_workspace_bytes {
        return Err(format!(
            "la conversación superaría su límite de {} (ya usa {})",
            format_bytes(info.max_workspace_bytes),
            format_bytes(used)
        ));
    }
    let inputs = dir.join(INPUTS);
    // El workspace lo crea (y lo restaura, D3) el sidecar al abrir la
    // conversación. Crearlo aquí dejaría una carpeta suelta junto a un
    // workspace archivado.
    if !inputs.is_dir() {
        return Err("la carpeta de ficheros de la conversación no está lista; vuelve a intentarlo".into());
    }
    let raw_name = source
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let name = unique_name(&inputs, &sanitize_file_name(&raw_name));
    let dest = inputs.join(&name);
    // Se copia a un temporal y se renombra: el agente nunca ve un fichero a medias.
    let tmp = inputs.join(format!(".{}.part", random_id()));
    let copied = copy_bounded(source, &tmp, info.max_file_bytes);
    let copied = match copied {
        Ok(n) => n,
        Err(e) => {
            let _ = fs::remove_file(&tmp);
            return Err(e);
        }
    };
    if let Err(e) = fs::rename(&tmp, &dest) {
        let _ = fs::remove_file(&tmp);
        return Err(format!("no se pudo guardar la copia: {e}"));
    }
    Ok((format!("{INPUTS}/{name}"), copied))
}

/// Copia como mucho `max` bytes: si el origen creció desde que se midió, falla
/// en vez de dejar pasar un fichero por encima del límite.
fn copy_bounded(source: &Path, dest: &Path, max: u64) -> Result<u64, String> {
    let input = fs::File::open(source).map_err(|e| format!("no se puede leer: {e}"))?;
    let mut output = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(dest)
        .map_err(|e| format!("no se pudo crear la copia: {e}"))?;
    let copied = io::copy(&mut input.take(max + 1), &mut output)
        .map_err(|e| format!("error al copiar: {e}"))?;
    if copied > max {
        return Err(format!(
            "supera el límite de {} por fichero",
            format_bytes(max)
        ));
    }
    output.flush().map_err(|e| e.to_string())?;
    Ok(copied)
}

/// Nombre seguro en Windows y Linux: sin separadores ni caracteres reservados,
/// sin nombres de dispositivo, sin puntos o espacios finales y con longitud
/// acotada conservando la extensión.
pub fn sanitize_file_name(name: &str) -> String {
    let mut s: String = name
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .collect();
    s = s.trim().trim_end_matches(['.', ' ']).to_string();
    if s.is_empty() || s.chars().all(|c| c == '.') {
        s = "fichero".into();
    }
    // Windows reserva el nombre de dispositivo con cualquier extensión (`con.tar.gz`).
    let stem = s.split('.').next().unwrap_or_default().trim_end();
    let stem_upper = stem.to_ascii_uppercase();
    let reserved = matches!(stem_upper.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ((stem_upper.starts_with("COM") || stem_upper.starts_with("LPT"))
            && stem_upper.len() == 4
            && stem_upper.as_bytes()[3].is_ascii_digit());
    if reserved {
        s = format!("_{s}");
    }
    truncate_name(&s, MAX_NAME_BYTES)
}

fn split_ext(name: &str) -> (&str, &str) {
    match name.rfind('.') {
        Some(i) if i > 0 && i < name.len() - 1 => (&name[..i], &name[i..]),
        _ => (name, ""),
    }
}

fn truncate_name(name: &str, max: usize) -> String {
    if name.len() <= max {
        return name.to_string();
    }
    let (stem, ext) = split_ext(name);
    let ext = if ext.len() > 16 { "" } else { ext };
    let mut cut = max.saturating_sub(ext.len());
    while !stem.is_char_boundary(cut.min(stem.len())) {
        cut -= 1;
    }
    format!("{}{}", &stem[..cut.min(stem.len())], ext)
}

/// `informe.pdf` → `informe (1).pdf`, `informe (2).pdf`… si ya existe.
pub fn unique_name(dir: &Path, name: &str) -> String {
    if !dir.join(name).exists() {
        return name.to_string();
    }
    let (stem, ext) = split_ext(name);
    for n in 1.. {
        let candidate = format!("{stem} ({n}){ext}");
        if !dir.join(&candidate).exists() {
            return candidate;
        }
    }
    unreachable!()
}

fn extension(name: &str) -> String {
    Path::new(name)
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default()
}

pub fn can_open(name: &str) -> bool {
    OPENABLE_EXTENSIONS.contains(&extension(name).as_str())
}

pub fn preview(path: &Path) -> Result<Preview, String> {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let ext = extension(&name);
    let size = fs::metadata(path).map_err(|e| e.to_string())?.len();
    if TEXT_PREVIEW_EXTENSIONS.contains(&ext.as_str()) {
        let mut buf = Vec::new();
        fs::File::open(path)
            .and_then(|f| f.take(PREVIEW_TEXT_BYTES).read_to_end(&mut buf))
            .map_err(|e| e.to_string())?;
        // Un corte a mitad de un carácter multibyte no invalida la vista.
        let text = String::from_utf8_lossy(&buf).into_owned();
        return Ok(Preview::Text {
            text,
            truncated: size > PREVIEW_TEXT_BYTES,
        });
    }
    if let Some((_, mime)) = IMAGE_PREVIEW_EXTENSIONS.iter().find(|(e, _)| *e == ext) {
        if size > PREVIEW_IMAGE_BYTES {
            return Ok(Preview::Unsupported {
                reason: format!(
                    "la imagen es demasiado grande para la vista previa ({})",
                    format_bytes(size)
                ),
            });
        }
        let bytes = fs::read(path).map_err(|e| e.to_string())?;
        return Ok(Preview::Image {
            data_url: format!("data:{mime};base64,{}", base64(&bytes)),
        });
    }
    Ok(Preview::Unsupported {
        reason: "no hay vista previa para este tipo de fichero".into(),
    })
}

/// «Descargar todo (.zip)» (D3, 16.7): `inputs/` y `outputs/` del workspace.
/// Sin `scratch/` (intermedios del agente) ni `.workspace.json`, y sin seguir
/// enlaces. Se escribe a un temporal junto al destino y se renombra al
/// terminar: un fallo a mitad no deja un zip truncado con el nombre final.
/// Devuelve cuántos ficheros metió.
pub fn export_zip(dir: &Path, target: &Path) -> Result<u64, String> {
    if !dir.join(INPUTS).is_dir() && !dir.join(OUTPUTS).is_dir() {
        return Err("los ficheros de esta conversación no están disponibles".into());
    }
    let tmp = target.with_file_name(format!(
        ".{}.{}.part",
        target.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
        random_id()
    ));
    let result = (|| -> Result<u64, String> {
        let file = fs::File::create(&tmp).map_err(|e| format!("no se pudo crear el zip: {e}"))?;
        let mut zip = zip::ZipWriter::new(io::BufWriter::new(file));
        let mut count = 0;
        for area in [INPUTS, OUTPUTS] {
            let root = dir.join(area);
            if root.is_dir() {
                add_to_zip(&mut zip, &root, area, &mut count)?;
            }
        }
        let mut writer = zip.finish().map_err(|e| e.to_string())?;
        writer.flush().map_err(|e| e.to_string())?;
        writer
            .into_inner()
            .map_err(|e| e.to_string())?
            .sync_all()
            .map_err(|e| e.to_string())?;
        Ok(count)
    })();
    match result {
        Ok(count) => {
            if let Err(e) = fs::rename(&tmp, target) {
                let _ = fs::remove_file(&tmp);
                return Err(format!("no se pudo guardar el zip: {e}"));
            }
            Ok(count)
        }
        Err(e) => {
            let _ = fs::remove_file(&tmp);
            Err(e)
        }
    }
}

fn add_to_zip<W: Write + io::Seek>(
    zip: &mut zip::ZipWriter<W>,
    dir: &Path,
    prefix: &str,
    count: &mut u64,
) -> Result<(), String> {
    let mut entries: Vec<_> = fs::read_dir(dir)
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .collect();
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
        let name = format!("{prefix}/{}", entry.file_name().to_string_lossy());
        let Ok(meta) = fs::symlink_metadata(entry.path()) else {
            continue;
        };
        if meta.is_dir() {
            zip.add_directory(format!("{name}/"), zip_options(0))
                .map_err(|e| e.to_string())?;
            add_to_zip(zip, &entry.path(), &name, count)?;
        } else if meta.is_file() {
            zip.start_file(name.as_str(), zip_options(meta.len()))
                .map_err(|e| e.to_string())?;
            let mut input =
                fs::File::open(entry.path()).map_err(|e| format!("no se puede leer {name}: {e}"))?;
            io::copy(&mut input, zip).map_err(|e| e.to_string())?;
            *count += 1;
        }
    }
    Ok(())
}

fn zip_options(size: u64) -> zip::write::SimpleFileOptions {
    zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .large_file(size >= u32::MAX as u64)
}

pub fn format_bytes(bytes: u64) -> String {
    const MB: u64 = 1024 * 1024;
    if bytes < 1024 {
        format!("{bytes} B")
    } else if bytes < MB {
        format!("{:.1} KB", bytes as f64 / 1024.0)
    } else {
        format!("{:.1} MB", bytes as f64 / MB as f64)
    }
}

fn random_id() -> String {
    let mut bytes = [0u8; 12];
    getrandom::fill(&mut bytes).expect("getrandom");
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn base64(data: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        out.push(TABLE[(n >> 18) as usize & 63] as char);
        out.push(TABLE[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { TABLE[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { TABLE[n as usize & 63] as char } else { '=' });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const CID: &str = "0b5b2c7e-5c1a-4f7e-8d3a-000000000001";

    fn setup(max_file: u64, max_ws: u64) -> (tempfile::TempDir, WorkspaceState, PathBuf) {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("workspaces");
        let dir = root.join(CID);
        for d in ["inputs", "outputs", "scratch"] {
            fs::create_dir_all(dir.join(d)).unwrap();
        }
        let state = WorkspaceState::default();
        state.set_info(Some(WorkspacesInfo {
            root,
            max_file_bytes: max_file,
            max_workspace_bytes: max_ws,
        }));
        (tmp, state, dir)
    }

    fn user_file(tmp: &tempfile::TempDir, name: &str, bytes: usize) -> PathBuf {
        let dir = tmp.path().join("usuario");
        fs::create_dir_all(&dir).unwrap();
        let p = dir.join(name);
        fs::write(&p, vec![b'a'; bytes]).unwrap();
        p
    }

    #[test]
    fn lee_los_datos_del_handshake() {
        let info = WorkspacesInfo::from_handshake(&json!({
            "root": std::env::temp_dir().to_string_lossy(),
            "maxFileBytes": 10, "maxWorkspaceBytes": 20
        }))
        .unwrap();
        assert_eq!(info.max_file_bytes, 10);
        assert!(WorkspacesInfo::from_handshake(&json!({"root": "relativa", "maxFileBytes": 1, "maxWorkspaceBytes": 1})).is_none());
        assert!(WorkspacesInfo::from_handshake(&json!({})).is_none());
    }

    #[test]
    fn valida_el_id_de_conversacion() {
        assert!(is_uuid(CID));
        for bad in ["", "..", "../etc", "0b5b2c7e-5c1a-4f7e-8d3a-00000000000g", "a/b"] {
            assert!(!is_uuid(bad), "{bad}");
        }
        let (_t, state, _) = setup(100, 1000);
        assert!(state.info().unwrap().conversation_dir("../x").is_err());
    }

    #[test]
    fn copia_al_workspace_sin_exponer_la_ruta_original() {
        let (tmp, state, dir) = setup(1000, 10_000);
        let src = user_file(&tmp, "ventas.csv", 10);
        let cands = state.grant(vec![src.clone()]);
        assert_eq!(cands.len(), 1);
        assert!(cands[0].error.is_none());
        let json = serde_json::to_string(&cands).unwrap();
        assert!(!json.contains("usuario"), "{json}");
        let res = state.attach(CID, &[cands[0].id.clone()]).unwrap();
        assert_eq!(res[0].path.as_deref(), Some("inputs/ventas.csv"));
        assert_eq!(fs::read(dir.join("inputs/ventas.csv")).unwrap().len(), 10);
        // El original sigue intacto y la concesión se consumió.
        assert_eq!(fs::read(&src).unwrap().len(), 10);
        let again = state.attach(CID, &[cands[0].id.clone()]).unwrap();
        assert!(again[0].error.as_deref().unwrap().contains("caducó"));
    }

    #[test]
    fn resuelve_colisiones_con_sufijo() {
        let (tmp, state, _) = setup(1000, 10_000);
        let src = user_file(&tmp, "informe.pdf", 5);
        let mut paths = vec![];
        for _ in 0..3 {
            let c = state.grant(vec![src.clone()]);
            paths.push(state.attach(CID, &[c[0].id.clone()]).unwrap()[0].path.clone().unwrap());
        }
        assert_eq!(
            paths,
            ["inputs/informe.pdf", "inputs/informe (1).pdf", "inputs/informe (2).pdf"]
        );
    }

    #[test]
    fn rechaza_por_limite_antes_de_copiar() {
        let (tmp, state, dir) = setup(100, 150);
        let big = user_file(&tmp, "grande.bin", 101);
        let cands = state.grant(vec![big]);
        assert!(cands[0].error.as_deref().unwrap().contains("límite"));
        // Sin concesión: no se puede adjuntar aunque el webview lo pida.
        let res = state.attach(CID, &[cands[0].id.clone()]).unwrap();
        assert!(res[0].error.is_some());
        assert_eq!(fs::read_dir(dir.join("inputs")).unwrap().count(), 0);
        // Límite del workspace: 80 + 80 > 150.
        let a = user_file(&tmp, "a.bin", 80);
        let b = user_file(&tmp, "b.bin", 80);
        let ca = state.grant(vec![a]);
        assert!(state.attach(CID, &[ca[0].id.clone()]).unwrap()[0].error.is_none());
        let cb = state.grant(vec![b]);
        let rb = state.attach(CID, &[cb[0].id.clone()]).unwrap();
        assert!(rb[0].error.as_deref().unwrap().contains("superaría"));
    }

    #[test]
    fn rechaza_carpetas() {
        let (tmp, state, _) = setup(100, 1000);
        let c = state.grant(vec![tmp.path().to_path_buf()]);
        assert!(c[0].error.as_deref().unwrap().contains("carpetas"));
    }

    #[test]
    fn sanea_nombres() {
        assert_eq!(sanitize_file_name("a/b\\c:d*e?.txt"), "a_b_c_d_e_.txt");
        assert_eq!(sanitize_file_name("con.txt"), "_con.txt");
        assert_eq!(sanitize_file_name("COM1"), "_COM1");
        assert_eq!(sanitize_file_name("informe.  "), "informe");
        assert_eq!(sanitize_file_name(".."), "fichero");
        assert_eq!(sanitize_file_name(""), "fichero");
        assert_eq!(sanitize_file_name("tab\there.md"), "tab_here.md");
        let long = format!("{}.pdf", "ñ".repeat(200));
        let s = sanitize_file_name(&long);
        assert!(s.len() <= MAX_NAME_BYTES && s.ends_with(".pdf"), "{s}");
    }

    #[test]
    fn solo_se_descartan_adjuntos_pendientes() {
        let (tmp, state, dir) = setup(1000, 10_000);
        let c = state.grant(vec![user_file(&tmp, "x.txt", 3)]);
        let rel = state.attach(CID, &[c[0].id.clone()]).unwrap()[0].path.clone().unwrap();
        let c2 = state.grant(vec![user_file(&tmp, "y.txt", 3)]);
        let rel2 = state.attach(CID, &[c2[0].id.clone()]).unwrap()[0].path.clone().unwrap();
        state.commit(CID, &[rel2.clone()]);
        state.discard(CID, &rel).unwrap();
        assert!(!dir.join(&rel).exists());
        assert!(state.discard(CID, &rel2).is_err());
        assert!(dir.join(&rel2).exists());
        assert!(state.discard(CID, "inputs/../outputs/z").is_err());
    }

    #[test]
    fn las_descargas_solo_salen_de_outputs() {
        let (tmp, state, dir) = setup(1000, 10_000);
        fs::write(dir.join("outputs/resumen.csv"), "a").unwrap();
        fs::write(dir.join("inputs/orig.csv"), "b").unwrap();
        let outside = user_file(&tmp, "secreto.txt", 3);
        assert!(state.output_path(CID, "outputs/resumen.csv").is_ok());
        for bad in [
            "inputs/orig.csv",
            "outputs/../inputs/orig.csv",
            "outputs",
            "outputs/",
            "../usuario/secreto.txt",
            "outputs/no-existe.txt",
        ] {
            assert!(state.output_path(CID, bad).is_err(), "{bad}");
        }
        let abs = outside.to_string_lossy().into_owned();
        assert!(state.output_path(CID, &abs).is_err());
    }

    #[test]
    fn una_descarga_no_sigue_enlaces_fuera() {
        let (tmp, state, dir) = setup(1000, 10_000);
        let outside = tmp.path().join("fuera");
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("s.txt"), "secreto").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, dir.join("outputs/link")).unwrap();
        #[cfg(windows)]
        {
            // Junction: no exige privilegios.
            let status = std::process::Command::new("cmd")
                .args(["/C", "mklink", "/J"])
                .arg(dir.join("outputs").join("link"))
                .arg(&outside)
                .output()
                .unwrap();
            assert!(status.status.success());
        }
        assert!(state.output_path(CID, "outputs/link/s.txt").is_err());
    }

    #[test]
    fn abrir_solo_tipos_inertes() {
        for ok in ["a.pdf", "b.CSV", "c.docx", "d.png", "e.md"] {
            assert!(can_open(ok), "{ok}");
        }
        for bad in ["a.bat", "b.ps1", "c.html", "d.svg", "e.js", "f.exe", "g.lnk", "h.docm", "sin-extension", "i.sh"] {
            assert!(!can_open(bad), "{bad}");
        }
    }

    #[test]
    fn vista_previa_de_texto_e_imagen() {
        let (_t, _state, dir) = setup(1000, 10_000);
        let txt = dir.join("outputs/a.md");
        fs::write(&txt, "# Hola").unwrap();
        assert_eq!(
            preview(&txt).unwrap(),
            Preview::Text { text: "# Hola".into(), truncated: false }
        );
        let png = dir.join("outputs/p.png");
        fs::write(&png, [0x89, b'P', b'N', b'G']).unwrap();
        match preview(&png).unwrap() {
            Preview::Image { data_url } => assert_eq!(data_url, "data:image/png;base64,iVBORw=="),
            other => panic!("{other:?}"),
        }
        let bin = dir.join("outputs/x.bin");
        fs::write(&bin, [0u8]).unwrap();
        assert!(matches!(preview(&bin).unwrap(), Preview::Unsupported { .. }));
    }

    #[test]
    fn no_crea_el_workspace_al_adjuntar() {
        let (tmp, state, _dir) = setup(1024, 4096);
        let src = user_file(&tmp, "a.txt", 10);
        let info = state.info().unwrap();
        // Sin carpeta: ni siquiera se resuelve.
        assert!(info.conversation_dir("0b5b2c7e-5c1a-4f7e-8d3a-0000000000ff").is_err());
        // Con carpeta pero sin `inputs/` (no la preparó el sidecar): no se crea.
        let other = info.root.join("0b5b2c7e-5c1a-4f7e-8d3a-0000000000fe");
        fs::create_dir_all(&other).unwrap();
        let err = copy_into_inputs(&info, &other, &src).unwrap_err();
        assert!(err.contains("no está lista"), "{err}");
        assert!(!other.join(INPUTS).exists());
    }

    #[test]
    fn exporta_inputs_y_outputs_a_zip() {
        let (tmp, _state, dir) = setup(1024, 4096);
        fs::write(dir.join(INPUTS).join("ventas.csv"), "mes,total
").unwrap();
        fs::create_dir_all(dir.join(OUTPUTS).join("sub")).unwrap();
        fs::write(dir.join(OUTPUTS).join("sub").join("año.md"), "# ñ").unwrap();
        fs::write(dir.join("scratch").join("notas.txt"), "privado").unwrap();
        fs::write(dir.join(".workspace.json"), "{}").unwrap();
        let target = tmp.path().join("todo.zip");
        assert_eq!(export_zip(&dir, &target).unwrap(), 2);

        let mut archive = zip::ZipArchive::new(fs::File::open(&target).unwrap()).unwrap();
        let mut names: Vec<String> = archive.file_names().map(String::from).collect();
        names.sort();
        assert_eq!(names, ["inputs/ventas.csv", "outputs/sub/", "outputs/sub/año.md"]);
        let mut content = String::new();
        archive
            .by_name("outputs/sub/año.md")
            .unwrap()
            .read_to_string(&mut content)
            .unwrap();
        assert_eq!(content, "# ñ");
        // Ni temporales junto al destino.
        let leftovers: Vec<_> = fs::read_dir(tmp.path())
            .unwrap()
            .filter_map(Result::ok)
            .filter(|e| e.file_name().to_string_lossy().ends_with(".part"))
            .collect();
        assert!(leftovers.is_empty());
    }

    #[test]
    fn exportar_un_workspace_que_no_esta_falla_sin_dejar_nada() {
        let tmp = tempfile::tempdir().unwrap();
        let target = tmp.path().join("todo.zip");
        assert!(export_zip(&tmp.path().join("no-existe"), &target).is_err());
        assert!(!target.exists());
    }

    #[test]
    fn base64_estandar() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
    }
}
