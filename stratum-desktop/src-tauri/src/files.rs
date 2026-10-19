//! Comandos Tauri de ficheros (D2) sobre `workspace.rs`, y el drag & drop.
//!
//! Los diálogos de abrir/guardar los abre Rust (`tauri-plugin-dialog` desde
//! Rust): el webview no tiene permisos del plugin, así que no puede abrir un
//! diálogo por su cuenta ni recibir rutas del disco (15.8).
//!
//! M12 — cada comando recibe el `cwd` de la sesión tal como lo publica el
//! daemon, y Rust decide si es una carpeta de conversación de Desktop
//! (`WorkspacesInfo::folder_of`): el webview no puede nombrar otra carpeta.

use crate::workspace::{self, Attached, Candidate, ListedFile, Preview, WorkspaceState};
use serde::Serialize;
use std::path::PathBuf;
use tauri::{AppHandle, DragDropEvent, Emitter, Manager, State, WebviewWindow, Window};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

/// El usuario arrastra ficheros sobre la ventana: `{ active: bool }`.
pub const EVENT_DRAG: &str = "attachments://drag";
/// Soltó ficheros: la lista de `Candidate` (sin rutas).
pub const EVENT_DROPPED: &str = "attachments://dropped";

#[derive(Serialize, Clone)]
struct DragState {
    active: bool,
}

/// Drag & drop sobre la ventana. Tauri entrega las rutas a Rust; al webview
/// solo le llegan candidatos con id opaco.
pub fn on_drag_drop(window: &Window, event: &DragDropEvent) {
    match event {
        DragDropEvent::Enter { .. } => {
            let _ = window.emit(EVENT_DRAG, DragState { active: true });
        }
        DragDropEvent::Leave => {
            let _ = window.emit(EVENT_DRAG, DragState { active: false });
        }
        DragDropEvent::Drop { paths, .. } => {
            let _ = window.emit(EVENT_DRAG, DragState { active: false });
            let candidates = window.state::<WorkspaceState>().grant(paths.clone());
            let _ = window.emit(EVENT_DROPPED, candidates);
        }
        _ => {}
    }
}

/// Sustitutos de los diálogos nativos para la suite E2E (feature `e2e`).
#[cfg(feature = "e2e")]
mod e2e_dialogs {
    use std::path::PathBuf;

    /// `STRATUM_E2E_PICK`: rutas separadas por `|` que «elige» el usuario.
    pub fn pick() -> Option<Vec<PathBuf>> {
        let raw = std::env::var("STRATUM_E2E_PICK").ok()?;
        Some(
            raw.split('|')
                .filter(|p| !p.is_empty())
                .map(PathBuf::from)
                .collect(),
        )
    }

    /// `STRATUM_E2E_SAVE_DIR`: carpeta donde «guarda» el diálogo, con el nombre propuesto.
    pub fn save(file_name: &str) -> Option<PathBuf> {
        std::env::var("STRATUM_E2E_SAVE_DIR")
            .ok()
            .map(|dir| PathBuf::from(dir).join(file_name))
    }
}

#[cfg(not(feature = "e2e"))]
mod e2e_dialogs {
    use std::path::PathBuf;

    pub fn pick() -> Option<Vec<PathBuf>> {
        None
    }

    pub fn save(_file_name: &str) -> Option<PathBuf> {
        None
    }
}

/// Botón de adjuntar: diálogo de selección múltiple.
#[tauri::command]
pub async fn attachments_pick(
    app: AppHandle,
    window: WebviewWindow,
) -> Result<Vec<Candidate>, String> {
    if let Some(paths) = e2e_dialogs::pick() {
        return Ok(app.state::<WorkspaceState>().grant(paths));
    }
    let handle = app.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        handle
            .dialog()
            .file()
            .set_title("Adjuntar ficheros")
            .set_parent(&window)
            .blocking_pick_files()
    })
    .await
    .map_err(|e| e.to_string())?;
    let paths: Vec<PathBuf> = picked
        .unwrap_or_default()
        .into_iter()
        .filter_map(|p| p.into_path().ok())
        .collect();
    Ok(app.state::<WorkspaceState>().grant(paths))
}

/// La carpeta de conversación de una sesión, por su `cwd`.
fn folder(app: &AppHandle, cwd: &str) -> Result<String, String> {
    app.state::<WorkspaceState>().info()?.folder_of(cwd)
}

/// Copia al `inputs/` de la sesión las concesiones elegidas.
#[tauri::command]
pub async fn attachments_add(
    app: AppHandle,
    cwd: String,
    ids: Vec<String>,
) -> Result<Vec<Attached>, String> {
    let id = folder(&app, &cwd)?;
    tauri::async_runtime::spawn_blocking(move || app.state::<WorkspaceState>().attach(&id, &ids))
        .await
        .map_err(|e| e.to_string())?
}

/// El mensaje que los llevaba salió: ya son parte de la conversación.
#[tauri::command]
pub fn attachments_commit(app: AppHandle, cwd: String, paths: Vec<String>) -> Result<(), String> {
    let id = folder(&app, &cwd)?;
    app.state::<WorkspaceState>().commit(&id, &paths);
    Ok(())
}

/// Quita un adjunto que aún no se ha enviado.
#[tauri::command]
pub fn attachments_discard(
    app: AppHandle,
    state: State<'_, WorkspaceState>,
    cwd: String,
    path: String,
) -> Result<(), String> {
    let id = folder(&app, &cwd)?;
    state.discard(&id, &path)
}

/// «Guardar como…»: copia un fichero de `outputs/` (o de `inputs/`, desde el
/// panel de ficheros de D4) donde el usuario elija.
/// Devuelve `false` si canceló el diálogo. La ruta elegida no vuelve al webview.
#[tauri::command]
pub async fn output_save(
    app: AppHandle,
    window: WebviewWindow,
    cwd: String,
    path: String,
) -> Result<bool, String> {
    let id = folder(&app, &cwd)?;
    let source = app.state::<WorkspaceState>().file_path(&id, &path)?;
    let file_name = source
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    if let Some(target) = e2e_dialogs::save(&file_name) {
        std::fs::copy(&source, &target).map_err(|e| format!("no se pudo guardar: {e}"))?;
        return Ok(true);
    }
    // Sin carpeta inicial, el diálogo arranca en el cwd del proceso (el home
    // del usuario en release, `src-tauri/` en dev): Descargas es lo esperable.
    let start_dir = app.path().download_dir().ok();
    let chosen = tauri::async_runtime::spawn_blocking(move || {
        let mut dialog = app
            .dialog()
            .file()
            .set_title("Guardar como")
            .set_file_name(file_name)
            .set_parent(&window);
        if let Some(dir) = start_dir {
            dialog = dialog.set_directory(dir);
        }
        dialog.blocking_save_file()
    })
    .await
    .map_err(|e| e.to_string())?;
    let Some(target) = chosen.and_then(|p| p.into_path().ok()) else {
        return Ok(false);
    };
    std::fs::copy(&source, &target).map_err(|e| format!("no se pudo guardar: {e}"))?;
    Ok(true)
}

/// «Descargar todo (.zip)» (D3, 16.7): `inputs/` y `outputs/` de la
/// conversación en un zip donde el usuario elija. Devuelve `false` si canceló.
#[tauri::command]
pub async fn workspace_export(
    app: AppHandle,
    window: WebviewWindow,
    cwd: String,
) -> Result<bool, String> {
    let id = folder(&app, &cwd)?;
    let dir = app
        .state::<WorkspaceState>()
        .info()?
        .conversation_dir(&id)?;
    let file_name = format!("stratum-ficheros-{}.zip", &id[..8]);
    if let Some(target) = e2e_dialogs::save(&file_name) {
        return tauri::async_runtime::spawn_blocking(move || workspace::export_zip(&dir, &target))
            .await
            .map_err(|e| e.to_string())?
            .map(|_| true);
    }
    let start_dir = app.path().download_dir().ok();
    let chosen = tauri::async_runtime::spawn_blocking(move || {
        let mut dialog = app
            .dialog()
            .file()
            .set_title("Descargar todos los ficheros")
            .set_file_name(file_name)
            .add_filter("Zip", &["zip"])
            .set_parent(&window);
        if let Some(dir) = start_dir {
            dialog = dialog.set_directory(dir);
        }
        dialog.blocking_save_file()
    })
    .await
    .map_err(|e| e.to_string())?;
    let Some(target) = chosen.and_then(|p| p.into_path().ok()) else {
        return Ok(false);
    };
    tauri::async_runtime::spawn_blocking(move || workspace::export_zip(&dir, &target))
        .await
        .map_err(|e| e.to_string())??;
    Ok(true)
}

/// Ficheros de `inputs/` y `outputs/` para el panel del sidebar (D4).
#[tauri::command]
pub async fn workspace_files(app: AppHandle, cwd: String) -> Result<Vec<ListedFile>, String> {
    let id = folder(&app, &cwd)?;
    tauri::async_runtime::spawn_blocking(move || app.state::<WorkspaceState>().list_files(&id))
        .await
        .map_err(|e| e.to_string())?
}

/// «Abrir» con la app por defecto del SO, solo para tipos inertes.
#[tauri::command]
pub fn output_open(app: AppHandle, cwd: String, path: String) -> Result<(), String> {
    let id = folder(&app, &cwd)?;
    let real = app.state::<WorkspaceState>().file_path(&id, &path)?;
    let name = real
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    if !workspace::can_open(&name) {
        return Err(
            "por seguridad, este tipo de fichero no se abre desde la app: guárdalo y ábrelo tú"
                .into(),
        );
    }
    app.opener()
        .open_path(strip_verbatim(&real), None::<&str>)
        .map_err(|e| format!("no se pudo abrir: {e}"))
}

#[tauri::command]
pub async fn output_preview(app: AppHandle, cwd: String, path: String) -> Result<Preview, String> {
    let id = folder(&app, &cwd)?;
    let real = app.state::<WorkspaceState>().file_path(&id, &path)?;
    tauri::async_runtime::spawn_blocking(move || workspace::preview(&real))
        .await
        .map_err(|e| e.to_string())?
}

/// `canonicalize` en Windows devuelve `\\?\C:\…`, que algunas apps no aceptan
/// como argumento.
fn strip_verbatim(path: &std::path::Path) -> String {
    let s = path.to_string_lossy();
    match s.strip_prefix(r"\\?\") {
        Some(rest) if !rest.starts_with("UNC\\") => rest.to_string(),
        _ => s.into_owned(),
    }
}
