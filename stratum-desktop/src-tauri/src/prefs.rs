//! Preferencias de la app (M12): la sección `desktop.*` del `.stratumrc.json`
//! global (`~/.stratum/.stratumrc.json`), **solo lectura**.
//!
//! Son preferencias de la interfaz —atajo global, notificaciones, buscar
//! actualizaciones, dónde guarda Desktop las carpetas de sus conversaciones—:
//! ningún estado de sesión. Antes de M12 las leía (y escribía) el sidecar;
//! ahora no hay sidecar, y Desktop no escribe la config: se edita con
//! `stratum config` o a mano (Ajustes lo dice y abre el fichero).
//!
//! Se lee con tolerancia: un campo que falta o no vale toma su valor por
//! defecto (el mismo del schema de `stratum-cli/src/config/schema.ts`), y un
//! fichero ilegible deja todo por defecto con un aviso. Nunca bloquea la app.

use crate::workspace::WorkspacesInfo;
use serde::Serialize;
use serde_json::Value;
use std::path::{Component, Path, PathBuf};

/// Igual que `DEFAULT_GLOBAL_HOTKEY` de `stratum-cli/src/config/accelerator.ts`.
pub const DEFAULT_HOTKEY: &str = "CommandOrControl+Shift+Space";
const MB: f64 = 1024.0 * 1024.0;
const DEFAULT_MAX_FILE_MB: f64 = 25.0;
const DEFAULT_MAX_WORKSPACE_MB: f64 = 250.0;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Notifications {
    pub enabled: bool,
    pub min_seconds: f64,
}

/// Lo que ve el webview: sin rutas salvo las que se le enseñan a la persona.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopPrefs {
    pub notifications: Notifications,
    pub global_hotkey: String,
    pub updates_auto_check: bool,
    /// Carpeta de las conversaciones del asistente (para enseñarla).
    pub workspaces_root: String,
    pub max_file_bytes: u64,
    pub max_workspace_bytes: u64,
    /// Ruta del fichero de configuración (para enseñarla y abrirlo).
    pub config_path: String,
    /// Avisos de la lectura (fichero ilegible, raíz no válida…).
    pub warnings: Vec<String>,
    /// Conversaciones de Desktop anteriores a M12 que aún no se importaron al
    /// daemon (`stratum desktop import`). Solo se cuentan: Desktop no las lee.
    pub legacy_conversations: usize,
}

impl DesktopPrefs {
    pub fn workspaces(&self) -> WorkspacesInfo {
        WorkspacesInfo {
            root: PathBuf::from(&self.workspaces_root),
            max_file_bytes: self.max_file_bytes,
            max_workspace_bytes: self.max_workspace_bytes,
        }
    }
}

pub fn config_path(home: &Path) -> PathBuf {
    home.join(".stratum").join(".stratumrc.json")
}

/// Carpeta por defecto de las conversaciones del asistente: la misma que usaba
/// Stratum Desktop antes de M12, así sus carpetas siguen donde estaban.
pub fn default_workspaces_root(home: &Path) -> PathBuf {
    home.join(".stratum").join("desktop").join("workspaces")
}

/// Lee las preferencias. Nunca falla: lo que no se puede leer va a `warnings`.
pub fn load(home: &Path) -> DesktopPrefs {
    let path = config_path(home);
    let mut warnings = Vec::new();
    let raw = match std::fs::read_to_string(&path) {
        Ok(text) => {
            let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
            match serde_json::from_str::<Value>(text) {
                Ok(value) => value,
                Err(e) => {
                    warnings.push(format!("No se pudo leer {}: {e}", path.display()));
                    Value::Null
                }
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Value::Null,
        Err(e) => {
            warnings.push(format!("No se pudo leer {}: {e}", path.display()));
            Value::Null
        }
    };
    let mut prefs = from_value(&raw, home, &path, warnings);
    prefs.legacy_conversations = legacy_pending(&home.join(".stratum").join("desktop"));
    prefs
}

/// Cuántas conversaciones de antes de M12 (`sessions/<uuid>.json`) no constan
/// en `imported.json`. Solo nombres de fichero: el contenido no se lee aquí.
pub fn legacy_pending(desktop_dir: &Path) -> usize {
    let Ok(entries) = std::fs::read_dir(desktop_dir.join("sessions")) else {
        return 0;
    };
    let imported: Value = std::fs::read_to_string(desktop_dir.join("imported.json"))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or(Value::Null);
    entries
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            name.strip_suffix(".json").map(str::to_string)
        })
        .filter(|id| crate::workspace::is_uuid(id))
        .filter(|id| imported["conversations"].get(id).is_none())
        .count()
}

fn from_value(raw: &Value, home: &Path, path: &Path, mut warnings: Vec<String>) -> DesktopPrefs {
    let desktop = &raw["desktop"];
    let notifications = Notifications {
        enabled: desktop["notifications"]["enabled"]
            .as_bool()
            .unwrap_or(true),
        min_seconds: desktop["notifications"]["minSeconds"]
            .as_f64()
            .filter(|n| (0.0..=3600.0).contains(n))
            .unwrap_or(10.0),
    };
    let global_hotkey = match desktop["globalHotkey"].as_str() {
        Some(text) if text.len() <= 64 => text.to_string(),
        _ => DEFAULT_HOTKEY.to_string(),
    };
    let updates_auto_check = desktop["updates"]["autoCheck"].as_bool().unwrap_or(true);

    let ws = &desktop["workspaces"];
    let fallback = default_workspaces_root(home);
    let root = match ws["root"].as_str().map(str::trim).filter(|r| !r.is_empty()) {
        None => fallback,
        Some(raw_root) => match workspace_root(raw_root, home) {
            Ok(root) => root,
            Err(problem) => {
                warnings.push(format!(
                    "desktop.workspaces.root «{raw_root}» no es válida ({problem}); se usa {}",
                    fallback.display()
                ));
                fallback
            }
        },
    };
    let max_file_mb = ws["maxFileMB"]
        .as_f64()
        .filter(|n| *n > 0.0 && *n <= 4096.0)
        .unwrap_or(DEFAULT_MAX_FILE_MB);
    let max_workspace_mb = ws["maxWorkspaceMB"]
        .as_f64()
        .filter(|n| *n > 0.0 && *n <= 65536.0 && *n >= max_file_mb)
        .unwrap_or(DEFAULT_MAX_WORKSPACE_MB.max(max_file_mb));

    DesktopPrefs {
        notifications,
        global_hotkey,
        updates_auto_check,
        workspaces_root: root.to_string_lossy().into_owned(),
        max_file_bytes: (max_file_mb * MB) as u64,
        max_workspace_bytes: (max_workspace_mb * MB) as u64,
        config_path: path.to_string_lossy().into_owned(),
        warnings,
        legacy_conversations: 0,
    }
}

/// Las mismas reglas que `resolveWorkspaceSettings` (D2): ruta absoluta, ni la
/// raíz de una unidad, ni el home ni un ancestro suyo.
fn workspace_root(raw: &str, home: &Path) -> Result<PathBuf, &'static str> {
    let expanded = if raw == "~" {
        home.to_path_buf()
    } else if let Some(rest) = raw.strip_prefix("~/").or_else(|| raw.strip_prefix("~\\")) {
        home.join(rest)
    } else {
        PathBuf::from(raw)
    };
    if !expanded.is_absolute() {
        return Err("tiene que ser una ruta absoluta");
    }
    let normal: PathBuf = expanded
        .components()
        .filter(|c| !matches!(c, Component::CurDir))
        .collect();
    if normal.parent().is_none() {
        return Err("no puede ser la raíz de una unidad");
    }
    let lower = |p: &Path| {
        let s = p.to_string_lossy().to_string();
        if cfg!(windows) {
            s.to_lowercase()
        } else {
            s
        }
    };
    if Path::new(&lower(home)).starts_with(lower(&normal)) {
        return Err("no puede ser el home ni una carpeta que lo contenga");
    }
    Ok(normal)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn home() -> PathBuf {
        if cfg!(windows) {
            PathBuf::from(r"C:\Users\ana")
        } else {
            PathBuf::from("/home/ana")
        }
    }

    fn prefs(raw: Value) -> DesktopPrefs {
        from_value(&raw, &home(), &config_path(&home()), Vec::new())
    }

    #[test]
    fn sin_config_todo_por_defecto() {
        let p = prefs(Value::Null);
        assert!(p.notifications.enabled);
        assert_eq!(p.notifications.min_seconds, 10.0);
        assert_eq!(p.global_hotkey, DEFAULT_HOTKEY);
        assert!(p.updates_auto_check);
        assert_eq!(
            PathBuf::from(&p.workspaces_root),
            default_workspaces_root(&home())
        );
        assert_eq!(p.max_file_bytes, 25 * 1024 * 1024);
        assert_eq!(p.max_workspace_bytes, 250 * 1024 * 1024);
        assert!(p.warnings.is_empty());
    }

    #[test]
    fn lee_lo_que_vale_y_descarta_lo_que_no() {
        let p = prefs(json!({ "desktop": {
            "notifications": { "enabled": false, "minSeconds": 99999 },
            "globalHotkey": "",
            "updates": { "autoCheck": false },
            "workspaces": { "root": "~/Trabajo", "maxFileMB": 5, "maxWorkspaceMB": 1 }
        }}));
        assert!(!p.notifications.enabled);
        assert_eq!(p.notifications.min_seconds, 10.0);
        assert_eq!(p.global_hotkey, "");
        assert!(!p.updates_auto_check);
        assert_eq!(PathBuf::from(&p.workspaces_root), home().join("Trabajo"));
        assert_eq!(p.max_file_bytes, 5 * 1024 * 1024);
        // Un tope de workspace menor que el de fichero no vale.
        assert_eq!(p.max_workspace_bytes, 250 * 1024 * 1024);
    }

    #[test]
    fn cuenta_las_conversaciones_antiguas_sin_importar() {
        let dir = tempfile::tempdir().unwrap();
        let desktop = dir.path();
        assert_eq!(legacy_pending(desktop), 0);
        std::fs::create_dir_all(desktop.join("sessions")).unwrap();
        for id in [
            "98694c97-e7cb-4af7-ac03-178d665bf810",
            "0b5b2c7e-5c1a-4f7e-8d3a-000000000001",
        ] {
            std::fs::write(desktop.join("sessions").join(format!("{id}.json")), "{}").unwrap();
        }
        std::fs::write(desktop.join("sessions").join("nota.json"), "{}").unwrap();
        assert_eq!(legacy_pending(desktop), 2);
        std::fs::write(
            desktop.join("imported.json"),
            r#"{"version":1,"conversations":{"98694c97-e7cb-4af7-ac03-178d665bf810":{"status":"imported","at":"x"}}}"#,
        )
        .unwrap();
        assert_eq!(legacy_pending(desktop), 1);
    }

    #[test]
    fn una_raiz_peligrosa_se_avisa_y_se_usa_la_de_siempre() {
        for bad in ["relativa/x", "~", if cfg!(windows) { "C:\\" } else { "/" }] {
            let p = prefs(json!({ "desktop": { "workspaces": { "root": bad } } }));
            assert_eq!(
                PathBuf::from(&p.workspaces_root),
                default_workspaces_root(&home()),
                "{bad}"
            );
            assert_eq!(p.warnings.len(), 1, "{bad}");
        }
    }
}
