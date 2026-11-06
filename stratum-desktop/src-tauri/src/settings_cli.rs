//! La CLI instalada, como ejecutor de `stratum config …` (ajustes editables).
//!
//! Es el **único** sitio de Desktop que lanza un proceso, y solo para
//! `stratum config`: Desktop no duplica el esquema de la configuración, así que
//! quien valida y escribe es la CLI (`stratum config set --global`). La
//! localiza como el arranque del daemon (`dot_link::launcher`): la variable
//! `STRATUM_DESKTOP_CLI` (un ejecutable, o un `.js` que se lanza con `node`), o
//! `stratum` del `PATH` (en Windows, un `.cmd` de npm, por `cmd.exe`).
//!
//! Lo que escribe la persona **nunca va en la línea de comandos** (se vería en
//! la lista de procesos, y `cmd.exe` interpretaría `&` o `|`): va por la
//! entrada estándar. Los argumentos son palabras fijas y una clave ya
//! normalizada; aun así se vuelven a comprobar aquí.

use crate::settings::{CliError, CliOutput, CliRunner};
use dot_link::launcher::DESKTOP_CLI_ENV;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// Cuánto se espera a la CLI (arrancar Node y validar tarda segundos, no más).
const TIMEOUT: Duration = Duration::from_secs(25);
/// Lo más que se lee de su salida.
const MAX_OUTPUT: u64 = 4 * 1024 * 1024;

pub struct InstalledCli {
    /// CLI explícita. `None`: `stratum` del `PATH`.
    cli: Option<PathBuf>,
    timeout: Duration,
}

impl InstalledCli {
    pub fn from_env() -> Self {
        Self {
            cli: std::env::var_os(DESKTOP_CLI_ENV)
                .filter(|v| !v.is_empty())
                .map(PathBuf::from),
            timeout: TIMEOUT,
        }
    }

    /// Programa y argumentos de `stratum <args>`.
    fn command_line(&self, args: &[&str]) -> (PathBuf, Vec<String>) {
        let tail = args.iter().map(|a| a.to_string());
        match &self.cli {
            Some(cli) => {
                let is_script = cli
                    .extension()
                    .and_then(|e| e.to_str())
                    .is_some_and(|e| matches!(e, "js" | "mjs" | "cjs"));
                if is_script {
                    let mut all = vec![cli.to_string_lossy().into_owned()];
                    all.extend(tail);
                    (PathBuf::from("node"), all)
                } else {
                    (cli.clone(), tail.collect())
                }
            }
            None if cfg!(windows) => {
                let mut all = vec!["/D".to_string(), "/C".to_string(), "stratum".to_string()];
                all.extend(tail);
                (PathBuf::from("cmd.exe"), all)
            }
            None => (PathBuf::from("stratum"), tail.collect()),
        }
    }
}

/// Un argumento permitido: letras, dígitos, `-`, `_` y `.`. Nada que `cmd.exe`
/// o un shell puedan interpretar.
fn plain_argument(arg: &str) -> bool {
    !arg.is_empty()
        && arg.len() <= 200
        && arg
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

fn read_limited(mut source: impl Read) -> String {
    let mut buffer = Vec::new();
    let _ = source.by_ref().take(MAX_OUTPUT).read_to_end(&mut buffer);
    String::from_utf8_lossy(&buffer).into_owned()
}

impl CliRunner for InstalledCli {
    fn run(&self, args: &[&str], stdin: Option<&str>) -> Result<CliOutput, CliError> {
        if !args.iter().all(|a| plain_argument(a)) {
            return Err(CliError::Io("argumento no permitido".into()));
        }
        let (program, all) = self.command_line(args);
        let mut command = Command::new(&program);
        command
            .args(&all)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = command.spawn().map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                CliError::NotFound
            } else {
                CliError::Io(format!("{:?}", e.kind()))
            }
        })?;
        // El valor, por la entrada estándar; al cerrarla la CLI sabe que terminó.
        if let Some(mut pipe) = child.stdin.take() {
            if let Some(text) = stdin {
                if pipe.write_all(text.as_bytes()).is_err() {
                    let _ = child.kill();
                    return Err(CliError::Io("no se pudo enviar el valor".into()));
                }
            }
        }
        let stdout = child
            .stdout
            .take()
            .map(|s| std::thread::spawn(move || read_limited(s)));
        let stderr = child
            .stderr
            .take()
            .map(|s| std::thread::spawn(move || read_limited(s)));
        let started = Instant::now();
        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break status,
                Ok(None) if started.elapsed() >= self.timeout => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(CliError::Timeout);
                }
                Ok(None) => std::thread::sleep(Duration::from_millis(25)),
                Err(e) => return Err(CliError::Io(format!("{:?}", e.kind()))),
            }
        };
        let out = stdout.and_then(|t| t.join().ok()).unwrap_or_default();
        let err = stderr.and_then(|t| t.join().ok()).unwrap_or_default();
        if status.success() {
            return Ok(CliOutput { stdout: out });
        }
        match status.code() {
            // cmd.exe: «no se reconoce como un comando»; shell: no encontrado.
            Some(9009) | Some(127) => Err(CliError::NotFound),
            _ => Err(CliError::Failed { stderr: err }),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn with_cli(cli: &str) -> InstalledCli {
        InstalledCli {
            cli: Some(PathBuf::from(cli)),
            timeout: Duration::from_secs(5),
        }
    }

    #[test]
    fn un_script_se_lanza_con_node_y_un_ejecutable_tal_cual() {
        let (program, args) = with_cli("dist/index.js").command_line(&["config", "list"]);
        assert_eq!(program, PathBuf::from("node"));
        assert_eq!(args, ["dist/index.js", "config", "list"]);
        let (program, args) = with_cli("/opt/stratum").command_line(&["config"]);
        assert_eq!(program, PathBuf::from("/opt/stratum"));
        assert_eq!(args, ["config"]);
    }

    #[test]
    fn sin_variable_usa_stratum_del_path() {
        let cli = InstalledCli {
            cli: None,
            timeout: TIMEOUT,
        };
        let (program, args) = cli.command_line(&["config", "list"]);
        let line = format!("{} {}", program.display(), args.join(" "));
        assert!(line.ends_with("stratum config list"), "{line}");
    }

    #[test]
    fn solo_argumentos_llanos() {
        for ok in ["config", "--global", "provider.providers.mi-ollama_2.model"] {
            assert!(plain_argument(ok), "{ok}");
        }
        for bad in [
            "", "a b", "a&b", "a|b", "a;b", "$(x)", "a\"b", "a%b", "a^b", "a\nb", "ñ", "a<b", "a>b",
        ] {
            assert!(!plain_argument(bad), "{bad:?}");
        }
    }

    #[test]
    fn un_argumento_con_metacaracteres_no_llega_a_lanzar_nada() {
        let cli = with_cli("definitivamente-no-existe");
        let err = cli.run(&["config", "set", "a&calc"], None).unwrap_err();
        assert_eq!(err, CliError::Io("argumento no permitido".into()));
    }

    #[test]
    fn una_cli_que_no_existe_es_not_found() {
        let err = with_cli("definitivamente-no-existe-stratum")
            .run(&["config"], None)
            .unwrap_err();
        assert_eq!(err, CliError::NotFound);
    }

    /// Un `.js` de mentira que repite su entrada: la prueba de que el valor viaja
    /// por la entrada estándar y no por argumentos. Se salta sin `node`.
    #[test]
    fn el_valor_viaja_por_la_entrada_estandar() {
        if Command::new("node").arg("--version").output().is_err() {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("fake-stratum.js");
        std::fs::write(
            &script,
            "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{\
             if(process.argv.slice(2).join(' ').includes('SECRETO')){process.exit(3)}\
             process.stdout.write(JSON.stringify({argv:process.argv.slice(2),stdin:d}))})",
        )
        .unwrap();
        let cli = with_cli(&script.to_string_lossy());
        let out = cli
            .run(
                &["config", "set", "--global", "logging.level"],
                Some("\"SECRETO\""),
            )
            .unwrap();
        let echo: serde_json::Value = serde_json::from_str(&out.stdout).unwrap();
        assert_eq!(echo["stdin"], "\"SECRETO\"");
        assert_eq!(
            echo["argv"],
            serde_json::json!(["config", "set", "--global", "logging.level"])
        );
    }

    /// Contra la CLI de verdad (`STRATUM_DESKTOP_TEST_CLI=<.../stratum-cli/dist/index.js>`):
    /// el contrato `config list|set --global` de punta a punta, con un HOME de usar y tirar.
    /// Sin la variable se salta; las demás pruebas no tocan el HOME.
    #[test]
    fn contra_la_cli_real_si_se_indica() {
        use crate::settings::{apply_set, load_view, ConfirmRequest, Confirmer};
        let Some(cli_path) = std::env::var_os("STRATUM_DESKTOP_TEST_CLI") else {
            return;
        };
        struct Yes;
        impl Confirmer for Yes {
            fn confirm(&self, _: &ConfirmRequest) -> Result<(), dot_link::state::CommandError> {
                Ok(())
            }
        }
        let home = tempfile::tempdir().unwrap();
        std::env::set_var("HOME", home.path());
        std::env::set_var("USERPROFILE", home.path());
        let cli = InstalledCli {
            cli: Some(PathBuf::from(cli_path)),
            timeout: Duration::from_secs(60),
        };
        let config = home.path().join(".stratum").join(".stratumrc.json");
        let view = load_view(&cli, &config);
        assert_eq!(view.state, "ready", "{:?}", view.reason);
        // Nivel A.
        let out = apply_set(
            &cli,
            &Yes,
            &config,
            "logging.level",
            &serde_json::json!("debug"),
        )
        .unwrap();
        assert!(out.changed);
        // Nivel B con un secreto: el fichero lo lleva, la vista no.
        let provider = crate::settings::NewProvider {
            alias: "nube".into(),
            base_url: "https://api.example/v1".into(),
            api_key: "sk-REAL-SECRETA".into(),
            model: "m".into(),
            make_default: true,
        };
        let out = crate::settings::apply_add_provider(&cli, &Yes, &config, &provider).unwrap();
        assert!(!serde_json::to_string(&out)
            .unwrap()
            .contains("REAL-SECRETA"));
        let text = std::fs::read_to_string(&config).unwrap();
        assert!(text.contains("sk-REAL-SECRETA") && text.contains("\"debug\""));
        // Un valor que Rust acepta pero el esquema de la CLI no (el tope por conversación
        // no puede ser menor que el de un fichero): se enseña su error y el fichero no cambia.
        let before = std::fs::read_to_string(&config).unwrap();
        let err = apply_set(
            &cli,
            &Yes,
            &config,
            "desktop.workspaces.maxWorkspaceMB",
            &serde_json::json!(1),
        )
        .unwrap_err();
        assert!(err.message.contains("maxWorkspaceMB"), "{}", err.message);
        assert_eq!(before, std::fs::read_to_string(&config).unwrap());
    }

    #[test]
    fn un_fallo_de_la_cli_devuelve_su_stderr() {
        if Command::new("node").arg("--version").output().is_err() {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("fail.js");
        std::fs::write(
            &script,
            "process.stderr.write('config no válida');process.exit(1)",
        )
        .unwrap();
        let err = with_cli(&script.to_string_lossy())
            .run(&["config"], None)
            .unwrap_err();
        assert_eq!(
            err,
            CliError::Failed {
                stderr: "config no válida".into()
            }
        );
    }
}
