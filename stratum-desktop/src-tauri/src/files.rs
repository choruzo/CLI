//! Comandos Tauri de ficheros (D2) sobre `workspace.rs`, y el drag & drop.
//!
//! Los diálogos de abrir/guardar los abre Rust (`tauri-plugin-dialog` desde
//! Rust): el webview no tiene permisos del plugin, así que no puede abrir un
//! diálogo por su cuenta ni recibir rutas del disco (15.8).

use crate::ipc::SidecarState;
use crate::workspace::{self, Attached, Candidate, Preview, WorkspaceState};
use serde::Serialize;
use serde_json::json;
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

/// Botón de adjuntar: diálogo de selección múltiple.
#[tauri::command]
pub async fn attachments_pick(
    app: AppHandle,
    window: WebviewWindow,
) -> Result<Vec<Candidate>, String> {
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

/// Copia al workspace las concesiones elegidas y avisa al sidecar.
#[tauri::command]
pub async fn attachments_add(
    app: AppHandle,
    conversation_id: String,
    ids: Vec<String>,
) -> Result<Vec<Attached>, String> {
    let handle = app.clone();
    let cid = conversation_id.clone();
    let results = tauri::async_runtime::spawn_blocking(move || {
        handle.state::<WorkspaceState>().attach(&cid, &ids)
    })
    .await
    .map_err(|e| e.to_string())??;
    if results.iter().any(|r| r.path.is_some()) {
        // Marca de uso para el sidecar (D3 no archivará un workspace recién usado).
        let _ = app.state::<SidecarState>().send_internal(json!({
            "type": "workspace_touch",
            "conversationId": conversation_id,
        }));
    }
    Ok(results)
}

/// Quita un adjunto que aún no se ha enviado.
#[tauri::command]
pub fn attachments_discard(
    state: State<'_, WorkspaceState>,
    conversation_id: String,
    path: String,
) -> Result<(), String> {
    state.discard(&conversation_id, &path)
}

/// «Guardar como…»: copia un fichero de `outputs/` donde el usuario elija.
/// Devuelve `false` si canceló el diálogo. La ruta elegida no vuelve al webview.
#[tauri::command]
pub async fn output_save(
    app: AppHandle,
    window: WebviewWindow,
    conversation_id: String,
    path: String,
) -> Result<bool, String> {
    let source = app.state::<WorkspaceState>().output_path(&conversation_id, &path)?;
    let file_name = source
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
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

/// «Abrir» con la app por defecto del SO, solo para tipos inertes.
#[tauri::command]
pub fn output_open(app: AppHandle, conversation_id: String, path: String) -> Result<(), String> {
    let real = app.state::<WorkspaceState>().output_path(&conversation_id, &path)?;
    let name = real
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    if !workspace::can_open(&name) {
        return Err("por seguridad, este tipo de fichero no se abre desde la app: guárdalo y ábrelo tú".into());
    }
    app.opener()
        .open_path(strip_verbatim(&real), None::<&str>)
        .map_err(|e| format!("no se pudo abrir: {e}"))
}

#[tauri::command]
pub async fn output_preview(
    app: AppHandle,
    conversation_id: String,
    path: String,
) -> Result<Preview, String> {
    let real = app.state::<WorkspaceState>().output_path(&conversation_id, &path)?;
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
