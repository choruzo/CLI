import { Channel, invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { EVENT_STATUS, type ClientFrame, type SidecarFrame, type SidecarStatus } from './types';

/**
 * Único punto de contacto del frontend con el sidecar. El webview no abre
 * sockets: todo pasa por el relay de Rust (`src-tauri/src/ipc.rs`), que es quien
 * tiene el token y hace el handshake.
 */

export function getSidecarStatus(): Promise<SidecarStatus> {
  return invoke<SidecarStatus>('sidecar_status');
}

export function onSidecarStatus(cb: (status: SidecarStatus) => void): Promise<UnlistenFn> {
  return listen<SidecarStatus>(EVENT_STATUS, (e) => cb(e.payload));
}

/**
 * Recibe cada trama del sidecar en orden. Las que llegaron antes de suscribirse
 * (p. ej. un error de config al arrancar) las entrega Rust nada más suscribirse.
 */
export async function subscribeSidecarFrames(cb: (frame: SidecarFrame) => void): Promise<void> {
  const channel = new Channel<SidecarFrame>();
  channel.onmessage = cb;
  await invoke('sidecar_subscribe', { onFrame: channel });
}

export function sendSidecarFrame(frame: ClientFrame): Promise<void> {
  return invoke('sidecar_send', { frame });
}
