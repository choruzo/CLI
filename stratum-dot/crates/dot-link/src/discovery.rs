//! Descubrimiento del daemon: `~/.stratum/daemon/endpoint.json`
//! (`docs/protocol.md` §4). Aquí solo se **lee** y se interpreta, con los
//! mismos cinco resultados que `stratum-cli/src/client/discovery.ts`. Publicar
//! el endpoint es cosa del daemon: Dot no lo escribe nunca.

use serde_json::Value;
use std::fmt;
use std::path::{Path, PathBuf};

use crate::PROTOCOL_VERSION;

pub const ENDPOINT_FILE: &str = "endpoint.json";

/// El token del canal. No implementa `Serialize` ni se imprime: solo sale de
/// aquí hacia `core.hello`, por [`Token::expose`].
#[derive(Clone, PartialEq, Eq)]
pub struct Token(String);

impl Token {
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for Token {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Token(<redacted>)")
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Endpoint {
    pub protocol: u64,
    pub pid: u32,
    pub started_at: String,
    pub version: String,
    pub ipc_path: String,
    pub token: Token,
}

impl Endpoint {
    /// Qué arranque del daemon es: cambia cada vez que arranca uno nuevo.
    pub fn identity(&self) -> (u32, String) {
        (self.pid, self.started_at.clone())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Discovery {
    Found(Endpoint),
    /// No hay endpoint publicado: ningún daemon en marcha.
    Absent,
    /// Hay endpoint, pero el proceso que lo publicó ya no existe.
    Stale {
        pid: u32,
    },
    /// El fichero no se puede leer o no tiene la forma esperada.
    Invalid {
        reason: String,
    },
    /// El daemon habla otra versión del protocolo: no merece la pena ni conectar.
    Incompatible {
        protocol: u64,
        version: String,
    },
}

/// Carpeta del endpoint: `<home>/.stratum/daemon/`.
pub fn default_endpoint_dir() -> Option<PathBuf> {
    home_dir().map(|home| home.join(".stratum").join("daemon"))
}

/// El directorio personal como lo resuelve Node (`os.homedir()`), que es quien
/// publica el endpoint: `USERPROFILE` en Windows, `HOME` en POSIX.
pub fn home_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        if let Some(profile) = std::env::var_os("USERPROFILE").filter(|v| !v.is_empty()) {
            return Some(PathBuf::from(profile));
        }
        let drive = std::env::var_os("HOMEDRIVE")?;
        let path = std::env::var_os("HOMEPATH")?;
        let mut home = PathBuf::from(drive);
        home.push(path);
        Some(home)
    }
    #[cfg(not(windows))]
    {
        std::env::var_os("HOME")
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
    }
}

fn positive_int(value: Option<&Value>) -> Option<u64> {
    value.and_then(Value::as_u64).filter(|n| *n > 0)
}

fn non_empty(value: Option<&Value>) -> Option<&str> {
    value.and_then(Value::as_str).filter(|s| !s.is_empty())
}

/// Interpreta el contenido de un `endpoint.json`. Puro: no toca disco ni
/// procesos. El motivo de un fichero inválido nombra el campo, nunca su valor:
/// el fichero lleva el token.
pub fn parse_endpoint(text: &str) -> Discovery {
    let invalid = |field: &str| Discovery::Invalid {
        reason: format!("bad field: {field}"),
    };
    let raw: Value = match serde_json::from_str(text.trim_start_matches('\u{feff}')) {
        Ok(v) => v,
        Err(_) => {
            return Discovery::Invalid {
                reason: "not valid JSON".into(),
            }
        }
    };
    if !raw.is_object() {
        return invalid("document");
    }
    let Some(protocol) = positive_int(raw.get("protocol")) else {
        return invalid("protocol");
    };
    let Some(pid) = positive_int(raw.get("pid")).and_then(|p| u32::try_from(p).ok()) else {
        return invalid("pid");
    };
    let Some(started_at) = non_empty(raw.get("startedAt")) else {
        return invalid("startedAt");
    };
    let Some(version) = non_empty(raw.get("version")) else {
        return invalid("version");
    };
    let Some(ipc_path) = non_empty(raw.get("ipcPath")) else {
        return invalid("ipcPath");
    };
    let Some(token) = raw
        .get("token")
        .and_then(Value::as_str)
        .filter(|t| t.len() >= 32)
    else {
        return invalid("token");
    };
    if protocol != PROTOCOL_VERSION {
        return Discovery::Incompatible {
            protocol,
            version: version.to_string(),
        };
    }
    Discovery::Found(Endpoint {
        protocol,
        pid,
        started_at: started_at.to_string(),
        version: version.to_string(),
        ipc_path: ipc_path.to_string(),
        token: Token(token.to_string()),
    })
}

/// ¿Existe un proceso con ese pid? Sin permiso para consultarlo también cuenta
/// como vivo: ante la duda no se da por muerto a un daemon.
pub fn process_alive(pid: u32) -> bool {
    #[cfg(windows)]
    {
        use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, ERROR_ACCESS_DENIED};
        use windows_sys::Win32::System::Threading::{
            GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
        };
        const STILL_ACTIVE: u32 = 259;
        // SAFETY: llamadas Win32 con un handle que se cierra aquí mismo.
        unsafe {
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if handle.is_null() {
                return GetLastError() == ERROR_ACCESS_DENIED;
            }
            let mut code = 0u32;
            let ok = GetExitCodeProcess(handle, &mut code);
            CloseHandle(handle);
            ok == 0 || code == STILL_ACTIVE
        }
    }
    #[cfg(unix)]
    {
        let Ok(pid) = libc::pid_t::try_from(pid) else {
            return false;
        };
        // SAFETY: `kill` con señal 0 solo comprueba la existencia del proceso.
        let rc = unsafe { libc::kill(pid, 0) };
        rc == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
    }
}

/// Lee e interpreta el endpoint de `dir`. Se llama en cada (re)conexión: el
/// daemon puede haber cambiado.
pub fn locate(dir: &Path) -> Discovery {
    locate_with(dir, process_alive)
}

/// Lo más que puede ocupar un `endpoint.json` (son unos cientos de bytes).
const MAX_ENDPOINT_BYTES: u64 = 64 * 1024;

/// Por qué no se lee el endpoint.
enum ReadError {
    NotFound,
    /// El fichero o su carpeta no son de fiar (el motivo, sin rutas ni contenido).
    Insecure(&'static str),
    Io(std::io::ErrorKind),
}

/// Abre el endpoint **sin seguir enlaces** y comprueba lo que se abrió (no la
/// ruta: así no hay carrera entre comprobar y leer). En POSIX, además, que sea
/// de este usuario y que nadie más pueda escribir ni en él ni en su carpeta.
/// En Windows no se comprueba el dueño: el perfil del usuario ya lo restringe
/// (`docs/dot.md` §14).
fn read_endpoint_file(dir: &Path) -> Result<String, ReadError> {
    use std::io::Read;
    let path = dir.join(ENDPOINT_FILE);
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // El handle es el del propio enlace, si lo es: se ve abajo y se rechaza.
        options.custom_flags(windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = match options.open(&path) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Err(ReadError::NotFound),
        #[cfg(unix)]
        Err(e) if e.raw_os_error() == Some(libc::ELOOP) => {
            return Err(ReadError::Insecure("the endpoint file is a symbolic link"))
        }
        Err(e) => return Err(ReadError::Io(e.kind())),
    };
    let meta = file.metadata().map_err(|e| ReadError::Io(e.kind()))?;
    if meta.file_type().is_symlink() {
        return Err(ReadError::Insecure("the endpoint file is a symbolic link"));
    }
    if !meta.is_file() {
        return Err(ReadError::Insecure("the endpoint is not a regular file"));
    }
    if meta.len() > MAX_ENDPOINT_BYTES {
        return Err(ReadError::Insecure("the endpoint file is too large"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        // SAFETY: `geteuid` no falla ni toca memoria.
        let me = unsafe { libc::geteuid() };
        if meta.uid() != me {
            return Err(ReadError::Insecure(
                "the endpoint file belongs to another user",
            ));
        }
        if meta.mode() & 0o022 != 0 {
            return Err(ReadError::Insecure(
                "the endpoint file is writable by other users",
            ));
        }
        let folder = std::fs::metadata(dir).map_err(|e| ReadError::Io(e.kind()))?;
        if folder.uid() != me {
            return Err(ReadError::Insecure(
                "the endpoint folder belongs to another user",
            ));
        }
        if folder.mode() & 0o022 != 0 {
            return Err(ReadError::Insecure(
                "the endpoint folder is writable by other users",
            ));
        }
    }
    let mut text = String::new();
    file.take(MAX_ENDPOINT_BYTES)
        .read_to_string(&mut text)
        .map_err(|e| ReadError::Io(e.kind()))?;
    Ok(text)
}

pub fn locate_with(dir: &Path, is_alive: impl Fn(u32) -> bool) -> Discovery {
    let text = match read_endpoint_file(dir) {
        Ok(t) => t,
        Err(ReadError::NotFound) => return Discovery::Absent,
        Err(ReadError::Insecure(why)) => {
            return Discovery::Invalid {
                reason: why.to_string(),
            }
        }
        Err(ReadError::Io(kind)) => {
            return Discovery::Invalid {
                reason: format!("cannot read endpoint file ({kind:?})"),
            }
        }
    };
    match parse_endpoint(&text) {
        Discovery::Found(endpoint) if !is_alive(endpoint.pid) => {
            Discovery::Stale { pid: endpoint.pid }
        }
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    fn endpoint_json(protocol: u64) -> String {
        format!(
            r#"{{"protocol":{protocol},"pid":4242,"startedAt":"2026-10-13T10:00:00.000Z","version":"0.9.0","ipcPath":"\\\\.\\pipe\\stratumd-x","token":"{TOKEN}"}}"#
        )
    }

    #[test]
    fn found_con_todos_los_campos() {
        let Discovery::Found(ep) = parse_endpoint(&endpoint_json(1)) else {
            panic!("found")
        };
        assert_eq!(ep.pid, 4242);
        assert_eq!(ep.version, "0.9.0");
        assert_eq!(ep.ipc_path, r"\\.\pipe\stratumd-x");
        assert_eq!(ep.token.expose(), TOKEN);
    }

    #[test]
    fn el_token_no_se_imprime() {
        let Discovery::Found(ep) = parse_endpoint(&endpoint_json(1)) else {
            panic!("found")
        };
        let printed = format!("{ep:?}");
        assert!(!printed.contains(TOKEN), "{printed}");
        assert!(printed.contains("redacted"));
    }

    #[test]
    fn incompatible_si_la_version_no_coincide() {
        assert_eq!(
            parse_endpoint(&endpoint_json(2)),
            Discovery::Incompatible {
                protocol: 2,
                version: "0.9.0".into()
            }
        );
    }

    #[test]
    fn invalid_nombra_el_campo_y_no_el_valor() {
        assert_eq!(
            parse_endpoint("no json"),
            Discovery::Invalid {
                reason: "not valid JSON".into()
            }
        );
        assert_eq!(
            parse_endpoint("[]"),
            Discovery::Invalid {
                reason: "bad field: document".into()
            }
        );
        let short = endpoint_json(1).replace(TOKEN, "corto");
        assert_eq!(
            parse_endpoint(&short),
            Discovery::Invalid {
                reason: "bad field: token".into()
            }
        );
        let no_pid = endpoint_json(1).replace("\"pid\":4242,", "");
        assert_eq!(
            parse_endpoint(&no_pid),
            Discovery::Invalid {
                reason: "bad field: pid".into()
            }
        );
    }

    #[test]
    fn acepta_bom() {
        let text = format!("\u{feff}{}", endpoint_json(1));
        assert!(matches!(parse_endpoint(&text), Discovery::Found(_)));
    }

    #[test]
    fn absent_stale_y_found_en_disco() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(locate(dir.path()), Discovery::Absent);
        std::fs::write(dir.path().join(ENDPOINT_FILE), endpoint_json(1)).unwrap();
        assert_eq!(
            locate_with(dir.path(), |_| false),
            Discovery::Stale { pid: 4242 }
        );
        assert!(matches!(
            locate_with(dir.path(), |_| true),
            Discovery::Found(_)
        ));
    }

    #[cfg(unix)]
    #[test]
    fn un_endpoint_que_otro_puede_escribir_no_se_cree() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join(ENDPOINT_FILE);
        std::fs::write(&file, endpoint_json(1)).unwrap();
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o666)).unwrap();
        assert_eq!(
            locate_with(dir.path(), |_| true),
            Discovery::Invalid {
                reason: "the endpoint file is writable by other users".into()
            }
        );
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600)).unwrap();
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o777)).unwrap();
        assert_eq!(
            locate_with(dir.path(), |_| true),
            Discovery::Invalid {
                reason: "the endpoint folder is writable by other users".into()
            }
        );
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        assert!(matches!(
            locate_with(dir.path(), |_| true),
            Discovery::Found(_)
        ));
    }

    #[test]
    fn un_endpoint_que_es_un_enlace_no_se_sigue() {
        let dir = tempfile::tempdir().unwrap();
        let elsewhere = dir.path().join("otro.json");
        std::fs::write(&elsewhere, endpoint_json(1)).unwrap();
        #[cfg(unix)]
        let made = std::os::unix::fs::symlink(&elsewhere, dir.path().join(ENDPOINT_FILE)).is_ok();
        // En Windows crear un enlace exige privilegio o modo desarrollador.
        #[cfg(windows)]
        let made =
            std::os::windows::fs::symlink_file(&elsewhere, dir.path().join(ENDPOINT_FILE)).is_ok();
        if !made {
            return;
        }
        assert_eq!(
            locate_with(dir.path(), |_| true),
            Discovery::Invalid {
                reason: "the endpoint file is a symbolic link".into()
            }
        );
    }

    #[test]
    fn un_endpoint_enorme_no_se_lee() {
        let dir = tempfile::tempdir().unwrap();
        let big = format!(
            "{}{}",
            endpoint_json(1),
            " ".repeat(MAX_ENDPOINT_BYTES as usize)
        );
        std::fs::write(dir.path().join(ENDPOINT_FILE), big).unwrap();
        assert_eq!(
            locate_with(dir.path(), |_| true),
            Discovery::Invalid {
                reason: "the endpoint file is too large".into()
            }
        );
    }

    #[test]
    fn una_carpeta_en_lugar_del_fichero_no_vale() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join(ENDPOINT_FILE)).unwrap();
        assert!(matches!(
            locate_with(dir.path(), |_| true),
            Discovery::Invalid { .. }
        ));
    }

    #[test]
    fn el_propio_proceso_esta_vivo() {
        assert!(process_alive(std::process::id()));
    }
}
