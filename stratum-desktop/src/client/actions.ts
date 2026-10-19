/**
 * Lo que la persona pide desde Desktop (M12), siempre al daemon:
 *
 *   petición → pendiente en la UI → respuesta → evento/foto → se pinta
 *
 * Ninguna acción cambia el estado de una sesión en el cliente: si el daemon
 * acepta, el cambio llega por eventos. Una petición que **cambia** algo y se
 * queda sin respuesta (`unknown`) **no se repite** sola: se dice que no se
 * sabe si se aplicó y la foto dirá qué pasó (`docs/protocol.md`, «el cliente
 * nunca reenvía»).
 */
import { attachmentsCommit } from '../ipc/files';
import { toCommandError, type CommandError, type NativeBridge } from '../ipc/native';
import { HISTORY_LIMITS } from '../protocol';
import {
  parseContextReport,
  parseHistoryPage,
  parseModels,
  parseOpenedSession,
  parseSessionMemory,
  parseStartedRun,
  type ModelList,
} from '../protocol/results';
import { settlePending } from './bridge';
import { protocolActions, protocolStore } from './protocol-store';
import { uiActions, type ControlKind, type PendingRequest } from './ui-store';

/** Página de historial que se pide. */
export const HISTORY_PAGE = Math.min(50, HISTORY_LIMITS.pageMessages);

/** Texto para una persona de un error de una petición. */
export function describeFailure(what: string, error: CommandError): string {
  switch (error.kind) {
    case 'unknown':
      return `${what}: no hubo respuesta y no se sabe si se aplicó. Comprueba la sesión antes de repetirlo.`;
    case 'not-sent':
      return `${what}: no se envió (${error.message})`;
    case 'no-answer':
      return `${what}: el daemon no contestó. Puedes volver a intentarlo.`;
    case 'invalid':
      return `${what}: ${error.message}`;
    case 'rejected':
      if (error.reason === 'peer-hosted') {
        return `${what}: esta sesión la aloja otra terminal; solo se puede redirigir o cancelar desde aquí.`;
      }
      if (error.reason === 'host-unavailable') {
        return `${what}: el proceso que aloja la sesión no responde.`;
      }
      if (error.code === 'BUSY') return `${what}: la sesión ya tiene un run en marcha.`;
      if (error.code === 'FORBIDDEN') return `${what}: el daemon no concede ese permiso a Desktop.`;
      return `${what}: ${error.message}`;
  }
}

export function selectSession(native: NativeBridge, sessionId: string | null): void {
  uiActions.select(sessionId);
  protocolActions.focus(sessionId);
  void native.focusSession(sessionId).catch(() => undefined);
}

/**
 * Conversación nueva con el asistente: una sesión normal del daemon
 * (`agent: 'assistant'`) en una carpeta nueva de Desktop. Se selecciona cuando
 * el daemon la devuelve. Devuelve su id, o `null` si no se abrió (o no se sabe).
 */
export async function newChat(native: NativeBridge, model?: string): Promise<string | null> {
  const request: PendingRequest = { kind: 'new-chat' };
  if (!uiActions.begin(request)) return null;
  try {
    const session = parseOpenedSession(await native.newChat(model));
    if (session) {
      selectSession(native, session.id);
      return session.id;
    }
    uiActions.notify(null, 'error', 'El daemon abrió una sesión con una respuesta que no se entiende.');
    return null;
  } catch (err) {
    const error = toCommandError(err);
    uiActions.notify(
      null,
      error.kind === 'unknown' ? 'warning' : 'error',
      error.kind === 'unknown'
        ? 'No hubo respuesta al abrir la conversación: si se abrió, aparecerá en la lista.'
        : describeFailure('No se pudo abrir la conversación', error),
    );
    return null;
  } finally {
    uiActions.end(request);
  }
}

/**
 * El primer mensaje de una conversación nueva: abre la sesión y, si se abrió,
 * lo envía. Si abrirla no tuvo respuesta, **no** se envía nada.
 */
export async function startConversation(native: NativeBridge, text: string): Promise<SendOutcome> {
  const sessionId = await newChat(native);
  if (!sessionId) return { restore: true };
  return sendMessage(native, { sessionId, cwd: null, mode: 'ask', text, attachments: [] });
}

export interface SendOutcome {
  /** Seguro que no se aplicó: el texto puede volver al campo para corregirlo. */
  restore: boolean;
}

/**
 * Un mensaje: `ask` es un run nuevo (`runs.start`); `steer` redirige el que
 * está en marcha (`runs.steer`). `attachments`: rutas de `inputs/` ya copiadas.
 */
export async function sendMessage(
  native: NativeBridge,
  opts: { sessionId: string; cwd: string | null; mode: 'ask' | 'steer'; text: string; attachments: string[] },
): Promise<SendOutcome> {
  const { sessionId, mode } = opts;
  const input = composeInput(opts.text, opts.attachments);
  if (mode === 'steer') {
    const request: PendingRequest = { kind: 'control', sessionId, action: 'steer', runId: null };
    if (!uiActions.begin(request)) return { restore: true };
    try {
      await native.steerRun(sessionId, input);
      return { restore: false };
    } catch (err) {
      const error = toCommandError(err);
      uiActions.notify(sessionId, 'warning', describeFailure('No se pudo redirigir', error));
      return { restore: error.kind !== 'unknown' };
    } finally {
      uiActions.end(request);
    }
  }
  const request: PendingRequest = { kind: 'send', sessionId, runId: null };
  if (!uiActions.begin(request)) return { restore: true };
  try {
    const run = parseStartedRun(await native.startRun(sessionId, input));
    if (opts.cwd && opts.attachments.length > 0) {
      void attachmentsCommit(opts.cwd, opts.attachments).catch(() => undefined);
    }
    if (run) {
      uiActions.update(request, { kind: 'send', sessionId, runId: run.id });
      settlePending();
    } else {
      uiActions.end(request);
    }
    return { restore: false };
  } catch (err) {
    uiActions.end(request);
    const error = toCommandError(err);
    uiActions.notify(sessionId, error.kind === 'unknown' ? 'warning' : 'error', describeFailure('No se pudo enviar', error));
    return { restore: error.kind !== 'unknown' };
  }
}

/** Lo que se envía como entrada del run: el texto y, si hay, qué ficheros acompañan. */
export function composeInput(text: string, attachments: string[]): string {
  const body = text.trim();
  if (attachments.length === 0) return body;
  const list = attachments.map((p) => `- ${p}`).join('\n');
  return `${body}\n\nFicheros adjuntos (en tu directorio de trabajo):\n${list}`.trim();
}

export async function control(
  native: NativeBridge,
  sessionId: string,
  action: Exclude<ControlKind, 'steer'>,
  runId: string | null,
): Promise<void> {
  const request: PendingRequest = { kind: 'control', sessionId, action, runId };
  if (!uiActions.begin(request)) return;
  try {
    const run = runId ?? undefined;
    if (action === 'pause') await native.pauseRun(sessionId, run);
    else if (action === 'resume') await native.resumeRun(sessionId, run);
    else await native.cancelRun(sessionId, run);
    // Aceptado no es aplicado: sigue pendiente hasta que la foto lo diga.
    settlePending();
  } catch (err) {
    uiActions.end(request);
    const label = action === 'pause' ? 'No se pudo pausar' : action === 'resume' ? 'No se pudo reanudar' : 'No se pudo cancelar';
    uiActions.notify(sessionId, 'warning', describeFailure(label, toCommandError(err)));
  }
}

export async function listModels(native: NativeBridge): Promise<ModelList | null> {
  try {
    return parseModels(await native.listModels());
  } catch (err) {
    uiActions.notify(null, 'warning', describeFailure('No se pudieron listar los modelos', toCommandError(err)));
    return null;
  }
}

export async function setModel(native: NativeBridge, sessionId: string, model: string): Promise<void> {
  const request: PendingRequest = { kind: 'set-model', sessionId };
  if (!uiActions.begin(request)) return;
  try {
    await native.setModel(sessionId, model);
  } catch (err) {
    uiActions.notify(sessionId, 'warning', describeFailure('No se pudo cambiar el modelo', toCommandError(err)));
  } finally {
    uiActions.end(request);
  }
}

/** Cerrar una sesión: en el daemon deja de existir (también guardada, M11). */
export async function closeSession(native: NativeBridge, sessionId: string): Promise<void> {
  const request: PendingRequest = { kind: 'close', sessionId };
  if (!uiActions.begin(request)) return;
  try {
    await native.closeSession(sessionId);
    settlePending();
  } catch (err) {
    uiActions.end(request);
    uiActions.notify(sessionId, 'warning', describeFailure('No se pudo cerrar la sesión', toCommandError(err)));
  }
}

/**
 * Una página más de historial (M11), anterior a lo que se tiene. Si llega
 * cuando ya se mira otra sesión, o ya no empalma, se descarta.
 */
export async function loadOlder(native: NativeBridge, sessionId: string): Promise<void> {
  if (!protocolActions.beginHistory(sessionId)) return;
  const state = protocolStore.get();
  const before = state.history?.older[0]?.id ?? state.focused?.snapshot?.messages[0]?.id;
  if (!before) {
    // Nada a lo que anclar la página (sin foto o sin mensajes): no hay qué pedir.
    protocolActions.historyFailed(sessionId, 'Todavía no hay mensajes.');
    return;
  }
  try {
    const page = parseHistoryPage(await native.history(sessionId, before, HISTORY_PAGE));
    if (!page) {
      protocolActions.historyFailed(sessionId, 'El historial que llegó no se entiende.');
      return;
    }
    protocolActions.addHistoryPage(sessionId, before, page.messages, page.hasMore);
  } catch (err) {
    protocolActions.historyFailed(sessionId, describeFailure('No se pudo leer el historial', toCommandError(err)));
  }
}

export async function readContext(native: NativeBridge, sessionId: string) {
  const [context, memory] = await Promise.all([
    native.context(sessionId).then(parseContextReport),
    native.memory(sessionId).then(parseSessionMemory),
  ]);
  return { context, memory };
}
