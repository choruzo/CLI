//! Proceso del sidecar `stratum-core` (15.2, 15.10, 15.11).
//!
//! Se lanza con `std::process` y no con el plugin shell de Tauri: hace falta
//! controlar stdin (el cierre de stdin es la orden de apagado), redirigir
//! stdout/stderr a un fichero y, en Windows, meter el proceso en un Job Object.
//!
//! Garantías contra huérfanos, de la más ordenada a la de último recurso:
//! 1. Cierre normal: Tauri cierra el stdin del sidecar, que ejecuta sus ganchos
//!    de apagado (servers MCP, sockets SSH, logs) y sale. Se espera `GRACE`.
//! 2. Si no salió a tiempo: `kill` (TerminateProcess / SIGKILL).
//! 3. Si Tauri muere sin poder hacer nada de lo anterior:
//!    - Windows: el Job Object con `KILL_ON_JOB_CLOSE` mata el sidecar y todo
//!      lo que haya lanzado cuando el SO cierra el último handle del job.
//!    - Linux: `PR_SET_PDEATHSIG` entrega SIGTERM al sidecar; además el sidecar
//!      ve EOF en stdin y se apaga solo.

use std::fs::File;
use std::io;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::time::{Duration, Instant};

/// Espera máxima al apagado ordenado antes de matar (§3, ciclo de vida).
pub const GRACE: Duration = Duration::from_secs(2);

/// Variable de entorno con el token del handshake (nunca por argumento: la línea
/// de comandos de un proceso la puede leer cualquier usuario de la máquina).
pub const TOKEN_ENV: &str = "STRATUM_DESKTOP_TOKEN";
pub const RESOURCES_ENV: &str = "STRATUM_RESOURCES_DIR";

pub const SIDECAR_NAME: &str = "stratum-core";

/// Token de 32 bytes aleatorios en hexadecimal (64 caracteres).
pub fn generate_token() -> io::Result<String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|e| io::Error::other(e.to_string()))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

/// Sufijo aleatorio corto para el nombre del pipe/socket: con solo el PID, otro
/// proceso podría adivinar el nombre y crearlo antes (pipe squatting).
pub fn random_suffix() -> io::Result<String> {
    let mut bytes = [0u8; 6];
    getrandom::fill(&mut bytes).map_err(|e| io::Error::other(e.to_string()))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

/// Ruta del canal local: named pipe en Windows, unix socket en Linux (15.10).
///
/// En Linux se usa `$XDG_RUNTIME_DIR` (0700, del usuario). Sin él, un directorio
/// privado nuevo en el temporal del sistema. La ruta de un unix socket tiene un
/// tope de ~108 bytes, de ahí los nombres cortos.
pub fn ipc_path(pid: u32, suffix: &str) -> io::Result<String> {
    #[cfg(windows)]
    {
        Ok(format!(r"\\.\pipe\stratum-desktop-{pid}-{suffix}"))
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let dir = match std::env::var_os("XDG_RUNTIME_DIR") {
            Some(d) if !d.is_empty() => PathBuf::from(d),
            _ => {
                let d = std::env::temp_dir().join(format!("stratum-{pid}-{suffix}"));
                std::fs::create_dir(&d)?;
                std::fs::set_permissions(&d, std::fs::Permissions::from_mode(0o700))?;
                d
            }
        };
        Ok(dir
            .join(format!("stratum-desktop-{pid}-{suffix}.sock"))
            .to_string_lossy()
            .into_owned())
    }
}

/// Tauri copia cada `externalBin` junto al ejecutable principal, sin el sufijo
/// del target triple (en `tauri dev`, en `target/debug`).
pub fn sidecar_exe_path() -> io::Result<PathBuf> {
    let exe = std::env::current_exe()?;
    let dir = exe
        .parent()
        .ok_or_else(|| io::Error::other("el ejecutable no tiene directorio padre"))?;
    Ok(dir.join(format!("{SIDECAR_NAME}{}", std::env::consts::EXE_SUFFIX)))
}

/// Quita el prefijo verbatim de Windows (`\\?\D:\…`) que llevan las rutas
/// canónicas, como las de `resource_dir()` de Tauri. La resolución de módulos de
/// Node no lo entiende (`EISDIR … lstat 'D:'`). Las UNC verbatim se dejan igual.
pub fn plain_path(path: &Path) -> PathBuf {
    let s = path.to_string_lossy();
    match s.strip_prefix(r"\\?\") {
        Some(rest) if !rest.starts_with(r"UNC\") => PathBuf::from(rest),
        _ => path.to_path_buf(),
    }
}

pub struct LaunchSpec<'a> {
    pub exe: &'a Path,
    pub ipc_path: &'a str,
    pub token: &'a str,
    pub resources_dir: &'a Path,
    pub cwd: &'a Path,
    pub log: File,
}

pub struct SidecarProcess {
    child: Child,
    stdin: Option<ChildStdin>,
    #[cfg(windows)]
    _job: job::Job,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShutdownOutcome {
    /// Salió por su cuenta dentro del plazo de gracia.
    Graceful(Option<i32>),
    /// Hubo que matarlo.
    Killed,
    /// Ya había terminado antes de pedirle nada.
    AlreadyExited(Option<i32>),
}

impl SidecarProcess {
    pub fn spawn(spec: LaunchSpec<'_>) -> io::Result<Self> {
        let stderr = spec.log.try_clone()?;
        let mut cmd = Command::new(spec.exe);
        cmd.arg("--ipc-path")
            .arg(spec.ipc_path)
            .arg("--watch-stdin")
            .env(TOKEN_ENV, spec.token)
            .env(RESOURCES_ENV, plain_path(spec.resources_dir))
            .current_dir(plain_path(spec.cwd))
            .stdin(Stdio::piped())
            .stdout(Stdio::from(spec.log))
            .stderr(Stdio::from(stderr));

        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            // Sin esto, un binario de consola abre su propia ventana negra.
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }

        #[cfg(target_os = "linux")]
        {
            use std::os::unix::process::CommandExt;
            // PDEATHSIG se dispara cuando muere el HILO que hizo el fork, no el
            // proceso: `spawn` tiene que llamarse desde un hilo que viva tanto
            // como la app. Por eso todos los lanzamientos, también los
            // reinicios, salen del hilo dedicado de `supervisor.rs`; desde un
            // worker de Tokio el sidecar moriría al terminar ese worker.
            let parent = std::process::id() as libc::pid_t;
            // SAFETY: solo llamadas async-signal-safe entre fork y exec.
            unsafe {
                cmd.pre_exec(move || {
                    if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM) != 0 {
                        return Err(io::Error::last_os_error());
                    }
                    // El padre pudo morir entre el fork y el prctl.
                    if libc::getppid() != parent {
                        return Err(io::Error::other("el proceso padre ya terminó"));
                    }
                    Ok(())
                });
            }
        }

        #[cfg(windows)]
        let job = job::Job::kill_on_close()?;

        let mut child = cmd.spawn()?;
        let stdin = child.stdin.take();

        #[cfg(windows)]
        if let Err(e) = job.assign(&child) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(e);
        }

        Ok(Self {
            child,
            stdin,
            #[cfg(windows)]
            _job: job,
        })
    }

    /// Solo tests: saca el stdin para poder filtrarlo y que el sidecar no vea
    /// EOF, aislando así la garantía del Job Object.
    #[cfg(all(test, windows))]
    pub fn stdin_for_test(&mut self) -> Option<ChildStdin> {
        self.stdin.take()
    }

    pub fn pid(&self) -> u32 {
        self.child.id()
    }

    /// `Some(código)` si ya terminó (el código es `None` si murió por señal).
    pub fn try_exit(&mut self) -> Option<Option<i32>> {
        match self.child.try_wait() {
            Ok(Some(status)) => Some(status.code()),
            _ => None,
        }
    }

    /// Apagado ordenado: cierra stdin, espera `grace` y, si sigue vivo, lo mata.
    pub fn shutdown(mut self, grace: Duration) -> ShutdownOutcome {
        if let Some(code) = self.try_exit() {
            return ShutdownOutcome::AlreadyExited(code);
        }
        // Cerrar stdin es la orden: el sidecar ve EOF y ejecuta sus ganchos.
        drop(self.stdin.take());
        let deadline = Instant::now() + grace;
        while Instant::now() < deadline {
            if let Some(code) = self.try_exit() {
                return ShutdownOutcome::Graceful(code);
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
        ShutdownOutcome::Killed
    }
}

#[cfg(windows)]
mod job {
    use std::io;
    use std::os::windows::io::AsRawHandle;
    use std::process::Child;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    /// Job Object con `KILL_ON_JOB_CLOSE`: al cerrarse su último handle —al
    /// soltarlo o porque el SO limpia un proceso Tauri que murió— el SO termina
    /// todos los procesos del job, incluidos los hijos del sidecar (servers MCP).
    pub struct Job(HANDLE);

    // SAFETY: un HANDLE de job es un identificador del kernel utilizable desde
    // cualquier hilo; aquí solo se asigna un proceso y se cierra.
    unsafe impl Send for Job {}
    unsafe impl Sync for Job {}

    impl Job {
        pub fn kill_on_close() -> io::Result<Self> {
            // SAFETY: llamadas Win32 con punteros válidos; el handle se comprueba.
            unsafe {
                let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if handle.is_null() {
                    return Err(io::Error::last_os_error());
                }
                let job = Job(handle);
                let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                let ok = SetInformationJobObject(
                    job.0,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const core::ffi::c_void,
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                );
                if ok == 0 {
                    return Err(io::Error::last_os_error());
                }
                Ok(job)
            }
        }

        pub fn assign(&self, child: &Child) -> io::Result<()> {
            // SAFETY: el handle del hijo es válido mientras exista `child`.
            let ok = unsafe { AssignProcessToJobObject(self.0, child.as_raw_handle() as HANDLE) };
            if ok == 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        }
    }

    impl Drop for Job {
        fn drop(&mut self) {
            // SAFETY: handle propio, se cierra una sola vez.
            unsafe { CloseHandle(self.0) };
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn el_token_son_32_bytes_en_hex() {
        let t = generate_token().unwrap();
        assert_eq!(t.len(), 64);
        assert!(t.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(t, generate_token().unwrap());
    }

    #[test]
    fn la_ruta_ipc_es_un_named_pipe_o_un_socket_privado() {
        let path = ipc_path(1234, "abcdef").unwrap();
        #[cfg(windows)]
        assert_eq!(path, r"\\.\pipe\stratum-desktop-1234-abcdef");
        #[cfg(unix)]
        {
            assert!(path.ends_with("stratum-desktop-1234-abcdef.sock"));
            assert!(path.len() < 108, "ruta de socket demasiado larga: {path}");
        }
    }

    #[test]
    fn plain_path_quita_el_prefijo_verbatim_salvo_en_unc() {
        assert_eq!(
            plain_path(Path::new(r"\\?\D:\app\res")),
            PathBuf::from(r"D:\app\res")
        );
        assert_eq!(
            plain_path(Path::new(r"\\?\UNC\srv\share")),
            PathBuf::from(r"\\?\UNC\srv\share")
        );
        assert_eq!(
            plain_path(Path::new("/usr/lib/stratum")),
            PathBuf::from("/usr/lib/stratum")
        );
    }

    #[test]
    fn el_ejecutable_del_sidecar_esta_junto_al_principal() {
        let p = sidecar_exe_path().unwrap();
        let name = p.file_name().unwrap().to_string_lossy().into_owned();
        assert_eq!(
            name,
            format!("stratum-core{}", std::env::consts::EXE_SUFFIX)
        );
    }
}
