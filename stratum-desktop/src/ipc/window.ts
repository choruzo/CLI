import { getCurrentWindow } from '@tauri-apps/api/window';

/**
 * Controles de la ventana frameless (D7). La ventana no tiene marco del SO: la
 * TitleBar propia minimiza, maximiza y cierra con estos permisos
 * (`core:window:allow-*` en `capabilities/default.json`), y arrastra con
 * `data-tauri-drag-region`, que también maximiza con doble clic.
 */

export function minimizeWindow(): Promise<void> {
  return getCurrentWindow().minimize();
}

export function toggleMaximizeWindow(): Promise<void> {
  return getCurrentWindow().toggleMaximize();
}

/** Cerrar pasa por `CloseRequested`: Rust guarda la posición y apaga el sidecar. */
export function closeWindow(): Promise<void> {
  return getCurrentWindow().close();
}

export function isWindowMaximized(): Promise<boolean> {
  return getCurrentWindow().isMaximized();
}

/** Avisa de cada cambio de tamaño (maximizar y restaurar incluidos). */
export function onWindowResized(cb: () => void): Promise<() => void> {
  return getCurrentWindow().onResized(() => cb());
}
