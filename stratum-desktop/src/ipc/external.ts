import { openUrl } from '@tauri-apps/plugin-opener';

/**
 * Abre un enlace en el navegador del sistema. El webview nunca navega fuera de
 * la app: un enlace de una respuesta que la sustituyese se llevaría consigo el
 * acceso a los comandos de Tauri. El scope del permiso en
 * `capabilities/default.json` repite la restricción a `http(s)`/`mailto` en Rust.
 */
export async function openExternal(url: string): Promise<void> {
  if (!/^(https?:|mailto:)/i.test(url.trim())) return;
  try {
    await openUrl(url);
  } catch (err) {
    console.warn('[stratum] no se pudo abrir el enlace', err);
  }
}
