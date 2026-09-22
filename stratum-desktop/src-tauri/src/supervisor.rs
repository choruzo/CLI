//! Supervisor del sidecar (D1, 15.5): lo lanza, mantiene el relay y lo
//! relanza si se cae, con backoff 1 → 2 → 5 → 10 s y un máximo de 4 intentos
//! seguidos. Agotados, queda en `failed` hasta que el usuario pulse Reintentar.
//!
//! Tres invariantes:
//! - Todos los `spawn` ocurren en **un único hilo del SO** que vive tanto como
//!   la app. En Linux `PR_SET_PDEATHSIG` se asocia al hilo que hace el fork, no
//!   al proceso (ver `sidecar.rs`): lanzar desde un worker de Tokio mataría el
//!   sidecar cuando ese worker terminase.
//! - El bucle es secuencial: lanzar → relay → apagar → esperar. Nunca hay dos
//!   sidecars ni dos relays vivos, y cada relay lleva su generación para que
//!   el cierre de uno viejo no toque el canal del nuevo.
//! - La salida de la app gana siempre: `begin_exit` marca `exiting` y retira el
//!   proceso bajo el mismo mutex con el que el supervisor lo instala, así que
//!   un sidecar lanzado en plena salida se apaga en el acto en vez de quedar
//!   huérfano.

use crate::ipc::{self, SidecarState, SidecarStatus};
use crate::logs;
use crate::sidecar::{self, LaunchSpec, SidecarProcess};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

/// Esperas entre intentos consecutivos (§D1: 1 → 2 → 5 → 10 s, máx. 4).
pub const BACKOFF_SECS: [u64; 4] = [1, 2, 5, 10];

/// Una conexión que dura al menos esto reinicia el contador de intentos. Con
/// solo haber autenticado no basta: un sidecar que conecta y muere al instante
/// se relanzaría para siempre.
pub const STABLE_AFTER: Duration = Duration::from_secs(30);

pub enum Command {
    /// Reintentar ya (botón de la UI tras agotar los intentos).
    Restart,
}

/// Espera antes del intento `failures` (1-based), o `None` si ya no quedan.
pub fn backoff_delay(failures: usize) -> Option<Duration> {
    failures
        .checked_sub(1)
        .and_then(|i| BACKOFF_SECS.get(i))
        .map(|s| Duration::from_secs(*s))
}

/// Fallos consecutivos tras una caída: se reinician si la conexión fue estable.
pub fn next_failures(previous: usize, connected_for: Option<Duration>) -> usize {
    match connected_for {
        Some(d) if d >= STABLE_AFTER => 1,
        _ => previous + 1,
    }
}

/// Resultado de un ciclo lanzar + relay.
struct Cycle {
    reason: String,
    connected_for: Option<Duration>,
    /// Error que no se arregla reintentando (falta el binario).
    fatal: bool,
}

pub fn start(app: AppHandle) {
    let (tx, rx) = mpsc::channel();
    app.state::<SidecarState>().set_supervisor(tx);
    let spawned = std::thread::Builder::new()
        .name("sidecar-supervisor".into())
        .spawn(move || run(app, rx));
    if let Err(e) = spawned {
        eprintln!("[stratum] no se pudo arrancar el supervisor del sidecar: {e}");
    }
}

fn run(app: AppHandle, rx: Receiver<Command>) {
    let mut failures = 0usize;
    let mut generation = 0u64;
    loop {
        // Un Reintentar pulsado mientras había conexión no debe saltarse la
        // espera de la siguiente caída.
        while rx.try_recv().is_ok() {}
        if app.state::<SidecarState>().is_exiting() {
            return;
        }
        generation += 1;
        let cycle = run_cycle(&app, generation);
        if app.state::<SidecarState>().is_exiting() {
            return;
        }

        if cycle.fatal {
            ipc::set_status(
                &app,
                SidecarStatus::Failed {
                    message: cycle.reason,
                },
            );
            failures = 0;
            match rx.recv() {
                Ok(Command::Restart) => continue,
                Err(_) => return,
            }
        }

        failures = next_failures(failures, cycle.connected_for);
        match backoff_delay(failures) {
            Some(delay) => {
                ipc::set_status(
                    &app,
                    SidecarStatus::Reconnecting {
                        attempt: failures as u32,
                        max_attempts: BACKOFF_SECS.len() as u32,
                        delay_ms: delay.as_millis() as u64,
                        reason: cycle.reason,
                    },
                );
                match rx.recv_timeout(delay) {
                    Ok(Command::Restart) | Err(RecvTimeoutError::Timeout) => {}
                    Err(RecvTimeoutError::Disconnected) => return,
                }
            }
            None => {
                ipc::set_status(
                    &app,
                    SidecarStatus::Failed {
                        message: format!(
                            "{} (tras {} intentos de reinicio)",
                            cycle.reason,
                            BACKOFF_SECS.len()
                        ),
                    },
                );
                match rx.recv() {
                    Ok(Command::Restart) => failures = 0,
                    Err(_) => return,
                }
            }
        }
    }
}

/// Lanza un sidecar, ejecuta el relay hasta que se cae y deja el proceso apagado.
fn run_cycle(app: &AppHandle, generation: u64) -> Cycle {
    let launched = match launch(app) {
        Ok(l) => l,
        Err((reason, fatal)) => {
            return Cycle {
                reason,
                connected_for: None,
                fatal,
            }
        }
    };
    let state = app.state::<SidecarState>();
    if let Err(process) = state.install_process(launched.process) {
        // La app empezó a salir entre el lanzamiento y la instalación.
        process.shutdown(sidecar::GRACE);
        return Cycle {
            reason: "la aplicación se está cerrando".into(),
            connected_for: None,
            fatal: false,
        };
    }

    let result = tauri::async_runtime::block_on(ipc::relay_once(
        app,
        &launched.ipc_path,
        &launched.token,
        generation,
    ));

    // El relay puede acabar con el proceso vivo (handshake rechazado, pipe
    // roto): se apaga antes de lanzar otro. Si la app está saliendo, el proceso
    // ya lo retiró `begin_exit` y aquí no hay nada.
    if let Some(process) = state.take_process() {
        let outcome = process.shutdown(sidecar::GRACE);
        eprintln!("[stratum] sidecar (generación {generation}) detenido: {outcome:?}");
    }

    match result {
        Ok(end) => Cycle {
            reason: end.reason,
            connected_for: Some(end.connected_for),
            fatal: false,
        },
        Err(reason) => Cycle {
            reason,
            connected_for: None,
            fatal: false,
        },
    }
}

struct Launched {
    process: SidecarProcess,
    ipc_path: String,
    token: String,
}

/// Lanza el proceso con token y ruta de pipe nuevos. `Err((motivo, fatal))`.
fn launch(app: &AppHandle) -> Result<Launched, (String, bool)> {
    let paths = app.path();
    // Sin directorio de logs de la app (perfil de usuario raro), el temporal del
    // sistema: quedarse sin log no puede dejar a la app sin agente.
    let log_dir = paths
        .app_log_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("stratum-desktop").join("logs"));
    let resources_dir = paths
        .resource_dir()
        .map_err(|e| (format!("sin directorio de resources: {e}"), true))?;
    let home = paths
        .home_dir()
        .map_err(|e| (format!("sin directorio home: {e}"), true))?;
    let exe = sidecar::sidecar_exe_path().map_err(|e| (e.to_string(), true))?;
    if !exe.exists() {
        return Err((
            format!(
                "no se encuentra el sidecar en {} (¿falta `npm run sidecar:build`?)",
                exe.display()
            ),
            true,
        ));
    }

    let (log, log_path) = logs::open_sidecar_log(&log_dir, logs::MAX_LOG_BYTES, logs::KEEP_ROTATED)
        .map_err(|e| (format!("no se pudo abrir el log del sidecar: {e}"), false))?;
    // Token y ruta nuevos en cada lanzamiento: nada de un sidecar anterior sirve
    // para hablar con este.
    let token = sidecar::generate_token()
        .map_err(|e| (format!("no se pudo generar el token: {e}"), false))?;
    let suffix = sidecar::random_suffix().map_err(|e| (e.to_string(), false))?;
    let ipc_path = sidecar::ipc_path(std::process::id(), &suffix)
        .map_err(|e| (format!("no se pudo preparar el canal local: {e}"), false))?;

    let started = Instant::now();
    let process = SidecarProcess::spawn(LaunchSpec {
        exe: &exe,
        ipc_path: &ipc_path,
        token: &token,
        resources_dir: &resources_dir,
        // El modo Chat no trabaja sobre ninguna carpeta; el proceso arranca en home.
        cwd: &home,
        log,
        home: None,
    })
    .map_err(|e| (format!("no se pudo lanzar {}: {e}", exe.display()), false))?;
    eprintln!(
        "[stratum] sidecar pid {} · log {} · lanzado en {:?}",
        process.pid(),
        log_path.display(),
        started.elapsed()
    );
    Ok(Launched {
        process,
        ipc_path,
        token,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_1_2_5_10_y_luego_nada() {
        let secs: Vec<_> = (1..=5)
            .map(|n| backoff_delay(n).map(|d| d.as_secs()))
            .collect();
        assert_eq!(secs, vec![Some(1), Some(2), Some(5), Some(10), None]);
        assert_eq!(backoff_delay(0), None);
    }

    #[test]
    fn solo_una_conexion_estable_reinicia_el_contador() {
        // Nunca llegó a conectar o conectó y murió al momento: cuenta.
        assert_eq!(next_failures(2, None), 3);
        assert_eq!(next_failures(2, Some(Duration::from_millis(500))), 3);
        // Aguantó el periodo estable: esta caída es la primera de una racha nueva.
        assert_eq!(next_failures(3, Some(STABLE_AFTER)), 1);
    }

    #[test]
    fn un_sidecar_que_muere_al_conectar_agota_los_intentos() {
        let mut failures = 0;
        let mut attempts = 0;
        loop {
            failures = next_failures(failures, Some(Duration::from_millis(10)));
            if backoff_delay(failures).is_none() {
                break;
            }
            attempts += 1;
        }
        assert_eq!(attempts, BACKOFF_SECS.len());
    }
}
