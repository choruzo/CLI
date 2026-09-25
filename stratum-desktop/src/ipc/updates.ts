import { Channel, invoke } from '@tauri-apps/api/core';

/**
 * Auto-update (D7), vía los comandos de `src-tauri/src/updates.rs`. El webview
 * no tiene permisos del plugin: pregunta y pide instalar; la descarga y la
 * verificación de la firma son de Rust.
 */

export interface UpdateInfo {
  version: string;
  currentVersion: string;
  notes: string | null;
  date: string | null;
}

export type UpdateProgress =
  | { event: 'progress'; downloaded: number; total: number | null }
  | { event: 'installing' };

export function checkForUpdate(): Promise<UpdateInfo | null> {
  return invoke<UpdateInfo | null>('update_check');
}

/** Descarga, instala y reinicia: si todo va bien, no vuelve. */
export function installUpdate(onProgress: (p: UpdateProgress) => void): Promise<void> {
  const channel = new Channel<UpdateProgress>();
  channel.onmessage = onProgress;
  return invoke('update_install', { onProgress: channel });
}
