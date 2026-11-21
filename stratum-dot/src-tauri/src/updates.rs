//! Auto-update contra GitHub Releases (M23), como Desktop (D7).
//!
//! El manifiesto (`latest.json`) vive en una release fija, `dot-updater`, que
//! `dot-release.yml` reescribe al publicar una release `dot-v*`: el «latest»
//! de GitHub es el de la CLI. Cada paquete va firmado con la clave minisign
//! cuya parte pública está en `tauri.conf.json` (la misma que Desktop): sin
//! firma válida el plugin no instala nada.
//!
//! El webview no tiene permisos del plugin: pregunta y pide instalar con estos
//! comandos. Nunca se instala sin que la persona lo pida. Antes de instalar se
//! guarda la geometría de la ventana (en Windows el instalador cierra Dot con
//! `process::exit`, sin pasar por `RunEvent::Exit`). El daemon y sus sesiones
//! no dependen de Dot: siguen.
//!
//! `STRATUM_UPDATE_ENDPOINT` sustituye el endpoint (pruebas contra un servidor
//! local); la firma se sigue exigiendo con la misma clave.

use serde::Serialize;
use std::sync::Mutex;
use tauri::ipc::Channel;
use tauri::{AppHandle, Runtime, State, Url};
use tauri_plugin_updater::{Update, Updater, UpdaterExt};
use tauri_plugin_window_state::{AppHandleExt, StateFlags};

#[derive(Default)]
pub struct UpdateState {
    /// La última actualización encontrada, a la espera de que la persona la instale.
    pending: Mutex<Option<Update>>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub version: String,
    pub current_version: String,
    /// Notas de la release (markdown), recortadas.
    pub notes: Option<String>,
    /// ISO 8601.
    pub date: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "event", rename_all = "camelCase")]
pub enum UpdateProgress {
    Progress { downloaded: u64, total: Option<u64> },
    Installing,
}

const MAX_NOTES_CHARS: usize = 4_000;

fn clip(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let mut out: String = text.chars().take(max).collect();
    out.push('…');
    out
}

/// La geometría de la ventana, como al salir (sin recordar si estaba oculta).
fn save_window<R: Runtime>(app: &AppHandle<R>) {
    let _ = app.save_window_state(StateFlags::all() & !StateFlags::VISIBLE);
}

fn updater<R: Runtime>(app: &AppHandle<R>) -> Result<Updater, String> {
    let mut builder = app.updater_builder();
    if let Ok(endpoint) = std::env::var("STRATUM_UPDATE_ENDPOINT") {
        let url =
            Url::parse(endpoint.trim()).map_err(|e| format!("STRATUM_UPDATE_ENDPOINT: {e}"))?;
        builder = builder.endpoints(vec![url]).map_err(|e| e.to_string())?;
    }
    let handle = app.clone();
    builder
        // Windows: el instalador termina el proceso; antes, la ventana.
        .on_before_exit(move || save_window(&handle))
        .build()
        .map_err(|e| e.to_string())
}

fn info_of(update: &Update) -> UpdateInfo {
    UpdateInfo {
        version: update.version.clone(),
        current_version: update.current_version.clone(),
        notes: update
            .body
            .as_deref()
            .map(str::trim)
            .filter(|b| !b.is_empty())
            .map(|b| clip(b, MAX_NOTES_CHARS)),
        date: update
            .raw_json
            .get("pub_date")
            .and_then(|d| d.as_str())
            .map(str::to_string),
    }
}

/// ¿Hay una versión más nueva? `None` si no. Un error (sin red, manifiesto
/// ausente) se devuelve como texto: la interfaz lo calla en la comprobación
/// automática y lo enseña en la manual.
#[tauri::command]
pub async fn dot_update_check<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, UpdateState>,
) -> Result<Option<UpdateInfo>, String> {
    let found = updater(&app)?.check().await.map_err(|e| e.to_string())?;
    let info = found.as_ref().map(info_of);
    *state.pending.lock().unwrap() = found;
    Ok(info)
}

/// Descarga, verifica la firma, instala y reinicia. Informa del progreso por
/// `on_progress`. Solo instala lo que encontró el último `dot_update_check`.
///
/// Si la instalación falla (la persona rechaza el UAC, el AppImage no se puede
/// escribir), Dot sigue abierto y conectado como estaba.
#[tauri::command]
pub async fn dot_update_install(
    app: AppHandle,
    state: State<'_, UpdateState>,
    on_progress: Channel<UpdateProgress>,
) -> Result<(), String> {
    let update = state
        .pending
        .lock()
        .unwrap()
        .take()
        .ok_or("There is no pending update: check again.")?;
    let mut downloaded: u64 = 0;
    let bytes = update
        .download(
            |chunk, total| {
                downloaded += chunk as u64;
                let _ = on_progress.send(UpdateProgress::Progress { downloaded, total });
            },
            || {},
        )
        .await
        .map_err(|e| e.to_string())?;
    let _ = on_progress.send(UpdateProgress::Installing);
    // En Linux el AppImage se sustituye con Dot vivo y se reinicia con la
    // versión nueva. En Windows, si el instalador arranca, no se vuelve de
    // `install` (el hook `on_before_exit` ya guardó la ventana).
    #[cfg(not(windows))]
    save_window(&app);
    update.install(bytes).map_err(|e| e.to_string())?;
    app.restart();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clip_respeta_caracteres_multibyte() {
        assert_eq!(clip("añadido", 20), "añadido");
        assert_eq!(clip("ñññññ", 3), "ñññ…");
    }
}
