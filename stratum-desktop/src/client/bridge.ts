/**
 * Une el lado nativo con los stores: cada `DesktopEvent` va a su sitio, y nada
 * más. Aquí no hay lógica del protocolo: validar y reducir es del contrato
 * (`protocol-store.ts` usa sus funciones).
 */
import type { DesktopEvent, NativeBridge } from '../ipc/native';
import { protocolActions, protocolStore, type ProtocolState } from './protocol-store';
import { uiActions, uiStore, type PendingRequest } from './ui-store';

/** ¿Sigue pendiente esta petición, vista la última foto? */
export function stillPending(request: PendingRequest, state: ProtocolState): boolean {
  if (request.kind === 'new-chat' || request.kind === 'set-model') return true;
  const listed = state.overview.sessions.find((s) => s.id === request.sessionId);
  if (request.kind === 'close') return listed !== undefined;
  // De lo que se pidió sobre un run, la foto lo dice; sin ella, se espera. La
  // foto de la sesión que se mira es más concreta que la de conjunto.
  const focused = state.focused?.sessionId === request.sessionId ? state.focused.snapshot : null;
  const session = focused?.session ?? listed;
  const run = focused?.run ?? null;
  if (request.kind === 'send') {
    if (!request.runId) return true;
    if (run?.id === request.runId) return false;
    return session?.currentRunId !== request.runId;
  }
  // control: la sesión ya no tiene el run, o el run ya está como se pidió.
  if (request.runId && run && run.id !== request.runId) return false;
  if (!session || session.state === 'closed') return false;
  const active = session.currentRunId !== null;
  switch (request.action) {
    case 'pause':
      return active && run?.status !== 'paused';
    case 'resume':
      return active && run?.status === 'paused';
    case 'cancel':
      return active;
    case 'steer':
      return false;
  }
}

/** Retira lo pendiente que la foto ya alcanzó. */
export function settlePending(): void {
  const state = protocolStore.get();
  if (uiStore.get().pending.length === 0) return;
  uiActions.settle((request) => stillPending(request, state));
}

export function handleDesktopEvent(native: NativeBridge, event: DesktopEvent): void {
  switch (event.type) {
    case 'connection':
      protocolActions.setConnection(event.state);
      break;
    case 'sessions':
      protocolActions.setListed();
      break;
    case 'overview':
      protocolActions.applyOverview(event.overview);
      break;
    case 'overview-events':
      protocolActions.applyOverviewEvents(event.events);
      break;
    case 'snapshot':
      protocolActions.applySnapshot(event.sessionId, event.snapshot);
      break;
    case 'events':
      // Si la secuencia no se pudo seguir, se pide otra foto: nunca se remienda.
      if (protocolActions.applyEvents(event.sessionId, event.events)) {
        void native.resyncSession(event.sessionId).catch(() => undefined);
      }
      break;
  }
  settlePending();
}

/**
 * Empieza a escuchar y avisa al lado nativo de que la interfaz está lista (lo
 * que hace que lleguen la foto de conjunto y la de la sesión que se mire).
 * Devuelve cómo parar.
 */
export async function startBridge(native: NativeBridge): Promise<() => void> {
  // Primero escuchar, después pedir: así no se pierde nada de lo que `attach` provoca.
  const stop = await native.onEvent((event) => {
    try {
      handleDesktopEvent(native, event);
    } catch (err) {
      console.error('desktop: event handler failed', err);
    }
  });
  const selected = uiStore.get().selectedId;
  if (selected) {
    protocolActions.focus(selected);
    await native.focusSession(selected).catch(() => undefined);
  }
  await native.attach();
  return stop;
}
