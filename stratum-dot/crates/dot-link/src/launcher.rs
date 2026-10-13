//! Arranque del daemon. Dot **no** tiene un lanzador propio: ejecuta el
//! comando oficial, `stratum daemon start`, que arranca `stratumd` desligado
//! (sobrevive a quien lo lanza) y es el único que publica `endpoint.json`.
//!
//! Dot nunca lo apaga: no hay nada aquí que detenga un daemon.

use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::process::Stdio;
use std::time::Duration;

pub type LaunchFuture<'a> = Pin<Box<dyn Future<Output = Result<(), String>> + Send + 'a>>;

pub trait DaemonLauncher: Send + Sync {
    /// Pide que haya un daemon en marcha. `Ok` cuando el comando terminó bien;
    /// quien llama comprueba después, por el descubrimiento, que atiende.
    fn start(&self) -> LaunchFuture<'_>;
}

/// No arranca nada (autostart desactivado).
pub struct NoLauncher;

impl DaemonLauncher for NoLauncher {
    fn start(&self) -> LaunchFuture<'_> {
        Box::pin(async { Err("starting the daemon is disabled".to_string()) })
    }
}

/// Variable de entorno con la CLI a usar en lugar de `stratum` del `PATH`: un
/// ejecutable, o un `.js` que se lanza con `node` (desarrollo y tests).
pub const CLI_ENV: &str = "STRATUM_DOT_CLI";

/// `stratum daemon start`, con la CLI instalada.
pub struct CliLauncher {
    /// CLI explícita. `None`: `stratum` del `PATH`.
    cli: Option<PathBuf>,
    timeout: Duration,
}

impl CliLauncher {
    pub fn from_env() -> Self {
        let cli = std::env::var_os(CLI_ENV)
            .filter(|v| !v.is_empty())
            .map(PathBuf::from);
        Self {
            cli,
            timeout: Duration::from_secs(30),
        }
    }

    pub fn with_cli(cli: PathBuf) -> Self {
        Self {
            cli: Some(cli),
            timeout: Duration::from_secs(30),
        }
    }

    /// Programa y argumentos de `stratum daemon start`.
    pub fn command_line(&self) -> (PathBuf, Vec<String>) {
        let tail = ["daemon".to_string(), "start".to_string()];
        match &self.cli {
            Some(cli) => {
                let is_script = cli
                    .extension()
                    .and_then(|e| e.to_str())
                    .map(|e| matches!(e, "js" | "mjs" | "cjs"))
                    .unwrap_or(false);
                if is_script {
                    let mut args = vec![cli.to_string_lossy().into_owned()];
                    args.extend(tail);
                    (PathBuf::from("node"), args)
                } else {
                    (cli.clone(), tail.to_vec())
                }
            }
            // En Windows `stratum` es un `.cmd` de npm: hay que pasarlo por cmd.
            None if cfg!(windows) => {
                let mut args = vec!["/D".to_string(), "/C".to_string(), "stratum".to_string()];
                args.extend(tail);
                (PathBuf::from("cmd.exe"), args)
            }
            None => (PathBuf::from("stratum"), tail.to_vec()),
        }
    }
}

impl DaemonLauncher for CliLauncher {
    fn start(&self) -> LaunchFuture<'_> {
        Box::pin(async move {
            let (program, args) = self.command_line();
            let mut command = tokio::process::Command::new(&program);
            // Sin tuberías: el daemon que queda vivo no puede heredar ninguna.
            command
                .args(&args)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            #[cfg(windows)]
            {
                const CREATE_NO_WINDOW: u32 = 0x0800_0000;
                command.creation_flags(CREATE_NO_WINDOW);
            }
            let mut child = command.spawn().map_err(|e| {
                if e.kind() == std::io::ErrorKind::NotFound {
                    "the `stratum` command was not found. Install stratum-cli, or start the daemon yourself with `stratum daemon start`.".to_string()
                } else {
                    format!("could not run `stratum daemon start` ({:?})", e.kind())
                }
            })?;
            match tokio::time::timeout(self.timeout, child.wait()).await {
                Ok(Ok(status)) if status.success() => Ok(()),
                Ok(Ok(status)) => Err(match status.code() {
                    // cmd.exe: «no se reconoce como un comando».
                    Some(9009) | Some(127) => {
                        "the `stratum` command was not found. Install stratum-cli, or start the daemon yourself with `stratum daemon start`.".to_string()
                    }
                    Some(code) => format!("`stratum daemon start` exited with code {code}"),
                    None => "`stratum daemon start` was terminated".to_string(),
                }),
                Ok(Err(e)) => Err(format!("`stratum daemon start` failed ({:?})", e.kind())),
                Err(_) => {
                    let _ = child.start_kill();
                    Err("`stratum daemon start` did not finish in time".to_string())
                }
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn usa_el_comando_oficial() {
        let (program, args) = CliLauncher {
            cli: None,
            timeout: Duration::from_secs(1),
        }
        .command_line();
        let line = format!("{} {}", program.display(), args.join(" "));
        assert!(line.ends_with("stratum daemon start"), "{line}");
    }

    #[test]
    fn un_script_se_lanza_con_node() {
        let (program, args) = CliLauncher::with_cli(PathBuf::from("dist/index.js")).command_line();
        assert_eq!(program, PathBuf::from("node"));
        assert_eq!(args, ["dist/index.js", "daemon", "start"]);
        let (program, args) = CliLauncher::with_cli(PathBuf::from("/opt/stratum")).command_line();
        assert_eq!(program, PathBuf::from("/opt/stratum"));
        assert_eq!(args, ["daemon", "start"]);
    }

    #[tokio::test]
    async fn una_cli_que_no_existe_da_un_error_legible() {
        let launcher = CliLauncher::with_cli(PathBuf::from("definitely-not-a-real-stratum-binary"));
        let err = launcher.start().await.unwrap_err();
        assert!(err.contains("not found"), "{err}");
    }
}
