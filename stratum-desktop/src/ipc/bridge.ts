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

type FrameListener = (frame: SidecarFrame) => void;

const listeners = new Set<FrameListener>();
let subscription: Promise<void> | null = null;

/**
 * Recibe cada trama del sidecar en orden. Rust admite **un solo** suscriptor
 * (el último `sidecar_subscribe` sustituye al anterior), así que el webview se
 * suscribe una vez y reparte aquí a todos los oyentes. Las tramas que llegaron
 * antes de suscribirse (p. ej. un error de config al arrancar) las entrega
 * Rust nada más suscribirse.
 */
export async function subscribeSidecarFrames(cb: FrameListener): Promise<() => void> {
  listeners.add(cb);
  subscription ??= (async () => {
    const channel = new Channel<SidecarFrame>();
    channel.onmessage = (frame) => {
      for (const l of listeners) l(frame);
    };
    await invoke('sidecar_subscribe', { onFrame: channel });
  })();
  try {
    await subscription;
  } catch (err) {
    subscription = null;
    listeners.delete(cb);
    throw err;
  }
  return () => {
    listeners.delete(cb);
  };
}

export function sendSidecarFrame(frame: ClientFrame): Promise<void> {
  return invoke('sidecar_send', { frame });
}

/** Reintentar tras agotar los reinicios automáticos del sidecar. */
export function restartSidecar(): Promise<void> {
  return invoke('sidecar_restart');
}
