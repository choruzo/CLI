//! Posición y tamaño de la ventana entre arranques (D7, punto ciego 15.14).
//!
//! La ventana es frameless: sin el marco del SO nada garantiza que al volver a
//! abrirla quede alcanzable. Si se cerró en un monitor que ya no está (portátil
//! sin la pantalla externa), el rectángulo guardado apunta a coordenadas que no
//! existen y la ventana arrancaría invisible, sin barra de título a la que
//! agarrarse. Al restaurar, el rectángulo se ajusta a las áreas de trabajo de
//! los monitores conectados (`clamp_to_monitors`, puro y con tests).
//!
//! Todo en píxeles físicos, igual que los monitores de Tauri. Se guarda el
//! rectángulo **normal** (el último sin maximizar ni minimizar) más si estaba
//! maximizada: maximizada, la posición es la del monitor y no sirve para
//! restaurar.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{
    AppHandle, Manager, PhysicalPosition, PhysicalSize, Runtime, WebviewWindow, WindowEvent,
};

const FILE: &str = "window-state.json";
/// Alto de la TitleBar propia (el de `--titlebar-height`, a escala 1).
pub const TITLE_STRIP: i32 = 32;
/// Ancho mínimo de la barra de título que tiene que quedar a la vista para
/// poder agarrarla y arrastrar la ventana.
pub const MIN_VISIBLE: i32 = 120;
/// Tamaño mínimo de la ventana (`minWidth`/`minHeight` de `tauri.conf.json`).
pub const MIN_SIZE: (u32, u32) = (640, 400);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

impl Rect {
    fn right(&self) -> i32 {
        self.x.saturating_add(self.width as i32)
    }
    fn bottom(&self) -> i32 {
        self.y.saturating_add(self.height as i32)
    }
    /// Área de la intersección con `other` (0 si no se tocan).
    fn overlap(&self, other: &Rect) -> i64 {
        let w = (self.right().min(other.right()) - self.x.max(other.x)).max(0) as i64;
        let h = (self.bottom().min(other.bottom()) - self.y.max(other.y)).max(0) as i64;
        w * h
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct SavedWindow {
    #[serde(flatten)]
    pub rect: Rect,
    #[serde(default)]
    pub maximized: bool,
}

/// Ajusta `saved` a las áreas de trabajo de los monitores conectados.
///
/// - El monitor de referencia es el que más superficie comparte con la
///   ventana; si no comparte nada con ninguno, el primero (el principal, que
///   el llamador pone delante) y la ventana se centra en él.
/// - El tamaño nunca supera el área de trabajo (una ventana de 2560 px no cabe
///   en el portátil de 1366 px), ni baja del mínimo salvo que el área sea menor.
/// - La barra de título queda dentro del área: el borde superior no sube por
///   encima de ella ni baja tanto que la barra se salga por abajo, y al menos
///   `MIN_VISIBLE` px de su anchura quedan a la vista en horizontal.
///
/// Sin monitores (el SO aún no los enumera) devuelve `saved` tal cual.
pub fn clamp_to_monitors(saved: Rect, work_areas: &[Rect]) -> Rect {
    let Some(first) = work_areas.first() else {
        return saved;
    };
    let best = work_areas
        .iter()
        .max_by_key(|a| saved.overlap(a))
        .filter(|a| saved.overlap(a) > 0);
    let area = best.unwrap_or(first);

    let width = saved.width.min(area.width).max(MIN_SIZE.0.min(area.width));
    let height = saved
        .height
        .min(area.height)
        .max(MIN_SIZE.1.min(area.height));

    if best.is_none() {
        return Rect {
            x: area.x + (area.width as i32 - width as i32) / 2,
            y: area.y + (area.height as i32 - height as i32) / 2,
            width,
            height,
        };
    }

    let visible = MIN_VISIBLE.min(width as i32);
    let x = saved
        .x
        .clamp(area.x - width as i32 + visible, area.right() - visible);
    let y = saved
        .y
        .clamp(area.y, (area.bottom() - TITLE_STRIP).max(area.y));
    Rect {
        x,
        y,
        width,
        height,
    }
}

/// Último rectángulo normal visto, mantenido al día con los eventos de la ventana.
#[derive(Default)]
pub struct WindowStateStore {
    current: Mutex<Option<SavedWindow>>,
}

fn state_path<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join(FILE))
}

pub fn read(path: &Path) -> Option<SavedWindow> {
    let text = std::fs::read_to_string(path).ok()?;
    let saved: SavedWindow = serde_json::from_str(&text).ok()?;
    (saved.rect.width > 0 && saved.rect.height > 0).then_some(saved)
}

fn write(path: &Path, saved: &SavedWindow) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(saved)?)?;
    std::fs::rename(tmp, path)
}

fn work_areas<R: Runtime>(window: &WebviewWindow<R>) -> Vec<Rect> {
    let primary = window.primary_monitor().ok().flatten();
    let mut monitors = window.available_monitors().unwrap_or_default();
    // El principal delante: es donde se centra una ventana huérfana.
    if let Some(p) = &primary {
        if let Some(i) = monitors.iter().position(|m| m.position() == p.position()) {
            let m = monitors.remove(i);
            monitors.insert(0, m);
        }
    }
    monitors
        .iter()
        .map(|m| {
            let a = m.work_area();
            Rect {
                x: a.position.x,
                y: a.position.y,
                width: a.size.width,
                height: a.size.height,
            }
        })
        .collect()
}

/// Coloca la ventana donde estaba (ajustada a los monitores actuales) y la
/// muestra. Arranca oculta (`visible: false`) para que no se vea el salto;
/// pase lo que pase aquí, termina visible.
pub fn restore<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let saved = state_path(app).and_then(|p| read(&p));
    if let Some(saved) = saved {
        let rect = clamp_to_monitors(saved.rect, &work_areas(&window));
        let _ = window.set_size(PhysicalSize::new(rect.width, rect.height));
        let _ = window.set_position(PhysicalPosition::new(rect.x, rect.y));
        app.state::<WindowStateStore>()
            .current
            .lock()
            .unwrap()
            .replace(SavedWindow { rect, ..saved });
        if saved.maximized {
            let _ = window.maximize();
        }
    } else {
        let _ = window.center();
    }
    let _ = window.show();
    let _ = window.set_focus();
}

/// Mantiene el rectángulo normal al día. Moverse o cambiar de tamaño estando
/// maximizada o minimizada no cuenta (en Windows, minimizada está en -32000).
pub fn track<R: Runtime>(window: &tauri::Window<R>, event: &WindowEvent) {
    let store = window.state::<WindowStateStore>();
    match event {
        WindowEvent::Moved(_) | WindowEvent::Resized(_) => {
            let maximized = window.is_maximized().unwrap_or(false);
            let minimized = window.is_minimized().unwrap_or(false);
            let mut current = store.current.lock().unwrap();
            if minimized {
                return;
            }
            if maximized {
                if let Some(c) = current.as_mut() {
                    c.maximized = true;
                }
                return;
            }
            if let (Ok(pos), Ok(size)) = (window.outer_position(), window.outer_size()) {
                if size.width > 0 && size.height > 0 {
                    *current = Some(SavedWindow {
                        rect: Rect {
                            x: pos.x,
                            y: pos.y,
                            width: size.width,
                            height: size.height,
                        },
                        maximized: false,
                    });
                }
            }
        }
        WindowEvent::CloseRequested { .. } => save(window.app_handle()),
        _ => {}
    }
}

/// Escribe el último estado conocido. Un fallo no impide cerrar.
pub fn save<R: Runtime>(app: &AppHandle<R>) {
    let current = *app.state::<WindowStateStore>().current.lock().unwrap();
    if let (Some(saved), Some(path)) = (current, state_path(app)) {
        if let Err(e) = write(&path, &saved) {
            eprintln!("[stratum] no se pudo guardar la posición de la ventana: {e}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FHD: Rect = Rect {
        x: 0,
        y: 0,
        width: 1920,
        height: 1040,
    };
    /// Monitor externo a la derecha del principal.
    const EXT: Rect = Rect {
        x: 1920,
        y: 0,
        width: 2560,
        height: 1400,
    };

    fn r(x: i32, y: i32, width: u32, height: u32) -> Rect {
        Rect {
            x,
            y,
            width,
            height,
        }
    }

    #[test]
    fn una_ventana_visible_se_queda_donde_estaba() {
        let w = r(100, 80, 1100, 720);
        assert_eq!(clamp_to_monitors(w, &[FHD]), w);
        let en_externo = r(2500, 200, 1100, 720);
        assert_eq!(clamp_to_monitors(en_externo, &[FHD, EXT]), en_externo);
    }

    #[test]
    fn sin_el_monitor_externo_se_centra_en_el_principal() {
        // Se cerró en el externo; ahora solo queda el portátil.
        let w = r(2500, 200, 1100, 720);
        assert_eq!(clamp_to_monitors(w, &[FHD]), r(410, 160, 1100, 720));
    }

    #[test]
    fn una_ventana_mas_grande_que_el_monitor_se_encoge() {
        // Maximizada en 2560x1400, restaurada en 1366x728.
        let laptop = r(0, 0, 1366, 728);
        let w = r(1920, 0, 2560, 1400);
        let out = clamp_to_monitors(w, &[laptop]);
        assert_eq!(out, r(0, 0, 1366, 728));
    }

    #[test]
    fn la_barra_de_titulo_no_queda_por_encima_ni_fuera_por_los_lados() {
        // Arrastrada casi entera fuera por arriba-izquierda.
        let out = clamp_to_monitors(r(-1050, -300, 1100, 720), &[FHD]);
        assert_eq!(out.y, 0);
        assert_eq!(out.x, -1100 + MIN_VISIBLE);
        // Y por abajo-derecha: la barra sigue a la vista.
        let out = clamp_to_monitors(r(1900, 1030, 1100, 720), &[FHD]);
        assert_eq!(out.x, 1920 - MIN_VISIBLE);
        assert_eq!(out.y, 1040 - TITLE_STRIP);
    }

    #[test]
    fn respeta_el_minimo_salvo_en_un_area_mas_pequena() {
        let out = clamp_to_monitors(r(10, 10, 200, 100), &[FHD]);
        assert_eq!((out.width, out.height), MIN_SIZE);
        let tiny = r(0, 0, 600, 380);
        let out = clamp_to_monitors(r(10, 10, 1100, 720), &[tiny]);
        assert_eq!((out.width, out.height), (600, 380));
    }

    #[test]
    fn monitor_a_la_izquierda_con_coordenadas_negativas() {
        let left = r(-1920, 0, 1920, 1040);
        let w = r(-1500, 100, 1100, 720);
        assert_eq!(clamp_to_monitors(w, &[FHD, left]), w);
        // Desconectado el de la izquierda: al principal.
        assert_eq!(clamp_to_monitors(w, &[FHD]), r(410, 160, 1100, 720));
    }

    #[test]
    fn sin_monitores_no_toca_nada() {
        let w = r(-5000, -5000, 800, 600);
        assert_eq!(clamp_to_monitors(w, &[]), w);
    }

    #[test]
    fn lee_y_escribe_el_fichero() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("sub").join(FILE);
        assert_eq!(read(&path), None);
        let saved = SavedWindow {
            rect: r(-10, 20, 1100, 720),
            maximized: true,
        };
        write(&path, &saved).unwrap();
        assert_eq!(read(&path), Some(saved));
        std::fs::write(&path, "{ roto").unwrap();
        assert_eq!(read(&path), None);
        std::fs::write(&path, r#"{"x":0,"y":0,"width":0,"height":10}"#).unwrap();
        assert_eq!(read(&path), None);
    }
}
