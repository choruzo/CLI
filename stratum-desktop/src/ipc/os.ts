import { invoke } from '@tauri-apps/api/core';

/**
 * Integración con el SO (D6), vía los comandos de `src-tauri/src/os.rs`. El
 * webview no tiene permisos de los plugins de notificación ni de atajos: Rust
 * decide si una notificación procede (ventana sin foco…) y acota su texto.
 */

/** Registra el atajo global (`''` lo quita). Devuelve el que queda registrado. */
export function setGlobalHotkey(accelerator: string): Promise<string | null> {
  return invoke<string | null>('os_set_hotkey', { accelerator });
}

/**
 * Notificación nativa si el usuario no está mirando: ventana sin foco,
 * minimizada u oculta, o `activeConversation: false`. Devuelve si se mostró.
 */
export async function notify(
  title: string,
  body: string,
  activeConversation: boolean,
): Promise<boolean> {
  try {
    return await invoke<boolean>('os_notify', { title, body, activeConversation });
  } catch (err) {
    console.warn('[stratum] notificación fallida', err);
    return false;
  }
}

/** Abre la carpeta de logs en el explorador de ficheros. */
export function openLogsDir(): Promise<void> {
  return invoke('logs_open');
}

export interface LogTail {
  path: string;
  text: string;
}

/** Últimas líneas de `sidecar.log`. */
export function readLogTail(lines = 40): Promise<LogTail> {
  return invoke<LogTail>('logs_tail', { lines });
}
