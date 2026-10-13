/**
 * Une el lado nativo con los stores: cada `DotEvent` va a su sitio, y nada más.
 * Aquí no hay lógica del protocolo: validar y reducir es de `protocol/apply.ts`.
 */
import { useConnection } from '../stores/connectionStore';
import { useSessions } from '../stores/sessionStore';
import { useUi } from '../stores/uiStore';
import type { DotEvent, NativeBridge } from './native';

export function handleDotEvent(native: NativeBridge, event: DotEvent): void {
  switch (event.type) {
    case 'connection':
      useConnection.getState().setState(event.state);
      break;
    case 'sessions':
      // La selección **no** se toca aunque su sesión no esté en la lista: tras
      // una caída del daemon, una sesión de terminal tarda un momento en volver
      // a registrarse, y al volver tiene que seguir seleccionada.
      useSessions.getState().setSessions(event.sessionIds);
      break;
    case 'snapshot':
      useSessions.getState().applySnapshot(event.sessionId, event.snapshot);
      break;
    case 'events':
      // Si la secuencia no se pudo seguir, se pide otra foto: nunca se remienda.
      if (useSessions.getState().applyEvents(event.sessionId, event.events)) {
        void native.resyncSession(event.sessionId).catch(() => undefined);
      }
      break;
  }
}

/**
 * Empieza a escuchar y avisa al lado nativo de que la interfaz está lista (lo
 * que hace que llegue una foto de cada sesión). Devuelve cómo parar.
 */
export async function startBridge(native: NativeBridge): Promise<() => void> {
  // Primero escuchar, después pedir: así no se pierde nada de lo que `attach` provoca.
  const stop = await native.onEvent((event) => {
    try {
      handleDotEvent(native, event);
    } catch (err) {
      console.error('dot: event handler failed', err);
    }
  });
  const info = await native.attach();
  useConnection.getState().setInfo(info);
  const selected = useUi.getState().selectedId;
  if (selected) void native.focusSession(selected).catch(() => undefined);
  return stop;
}
