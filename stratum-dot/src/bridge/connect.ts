/**
 * Une el lado nativo con los stores: cada `DotEvent` va a su sitio, y nada más.
 * Aquí no hay lógica del protocolo: validar y reducir es de `protocol/apply.ts`.
 */
import { watchRoutineRuns } from '../app/routines';
import { useApprover } from '../stores/approverStore';
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
      useSessions.getState().setSessions(event.sessionIds, event.unfollowed ?? 0);
      break;
    case 'snapshot':
      useSessions.getState().applySnapshot(event.sessionId, event.snapshot);
      break;
    case 'events':
      // Si la secuencia no se pudo seguir, se pide otra foto: nunca se remienda.
      if (useSessions.getState().applyEvents(event.sessionId, event.events)) {
        void native.resyncSession(event.sessionId).catch(() => undefined);
      }
      // M16: el inicio o el fin de un run de la sesión de una rutina refresca la lista (y avisa).
      watchRoutineRuns(native, event.sessionId, event.events);
      break;
    case 'approver':
      useApprover.getState().setStatus(event.status);
      break;
    case 'open-view':
      // La bandeja pide el centro de aprobaciones: se abre, sin resolver nada.
      if (event.view === 'human-input') useUi.getState().openHumanInput();
      break;
    case 'ask':
      // El Dot compacto: el mensaje va al asistente (lo envía su vista al tener su sesión).
      if (typeof event.text === 'string' && event.text.trim()) useUi.getState().askAssistant(event.text);
      break;
    case 'open-session':
      // M16: se pulsó el aviso de una rutina. Solo se selecciona su sesión: nada se resuelve.
      useUi.getState().select(event.sessionId);
      void native.focusSession(event.sessionId).catch(() => undefined);
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
  // Al recargar la interfaz, el broker sigue como estaba: se le pregunta.
  void native
    .approverStatus()
    .then((status) => useApprover.getState().setStatus(status))
    .catch(() => undefined);
  const selected = useUi.getState().selectedId;
  if (selected) void native.focusSession(selected).catch(() => undefined);
  return stop;
}
