/**
 * Lo que la persona pide en el **modo código**, siempre al daemon y con las
 * mismas reglas que `actions.ts`: nada cambia en el cliente hasta que el daemon
 * lo publica, y una petición mutante sin respuesta no se repite sola.
 *
 * Deshacer turnos (`sessions.revert`) exige la autoridad de aprobar: sale por
 * el broker nativo y solo tras confirmarlo la persona en su ventana, como
 * aprobar una solicitud (`approvals.ts`). Desktop nunca fuerza un deshacer con
 * conflictos.
 */
import { toCommandError, type CommandError, type NativeBridge } from '../ipc/native';
import { parseAgents, parseChanges, parseDiff, parseOpenedSession, parseRevert } from '../protocol/results';
import { describeFailure, selectSession, sendMessage, type SendOutcome } from './actions';
import { uiActions, type PendingRequest } from './ui-store';

export type Changes = NonNullable<ReturnType<typeof parseChanges>>;
export type FileDiff = NonNullable<ReturnType<typeof parseDiff>>;
export type RevertResult = NonNullable<ReturnType<typeof parseRevert>>;
export type AgentProfile = NonNullable<ReturnType<typeof parseAgents>>[number];

export interface CodeSessionChoice {
  cwd: string;
  /** Perfil de agente; sin él, `general`. */
  agent?: string;
  provider?: string;
  model?: string;
}

/**
 * Sesión de código nueva en la carpeta de un proyecto: una sesión normal del
 * daemon, como la que abre la CLI. Se selecciona cuando el daemon la devuelve.
 */
export async function newCodeSession(native: NativeBridge, choice: CodeSessionChoice): Promise<string | null> {
  const request: PendingRequest = { kind: 'new-chat' };
  if (!uiActions.begin(request)) return null;
  try {
    const session = parseOpenedSession(await native.newCodeSession(choice));
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
        ? 'No hubo respuesta al abrir la sesión: si se abrió, aparecerá en la lista.'
        : describeFailure('No se pudo abrir la sesión', error),
    );
    return null;
  } finally {
    uiActions.end(request);
  }
}

/** El primer mensaje de una sesión de código: la abre y, si se abrió, lo envía. */
export async function startCodeConversation(
  native: NativeBridge,
  text: string,
  choice: CodeSessionChoice,
  opts: { plan?: boolean } = {},
): Promise<SendOutcome> {
  const sessionId = await newCodeSession(native, choice);
  if (!sessionId) return { restore: true };
  return sendMessage(native, { sessionId, cwd: null, mode: 'ask', text, attachments: [], ...(opts.plan ? { plan: true } : {}) });
}

/** Diálogo nativo para elegir la carpeta del proyecto; `null` si se cancela. */
export async function pickProjectFolder(native: NativeBridge): Promise<string | null> {
  try {
    return await native.pickProjectFolder();
  } catch (err) {
    uiActions.notify(null, 'warning', describeFailure('No se pudo elegir la carpeta', toCommandError(err)));
    return null;
  }
}

/** Los perfiles de agente principal que valen en esa carpeta (`agents.list`). */
export async function listProfiles(native: NativeBridge, cwd: string | null): Promise<AgentProfile[] | null> {
  try {
    const agents = parseAgents(await native.listAgents(cwd ?? undefined));
    return agents ? agents.filter((a) => a.mode !== 'subagent') : null;
  } catch {
    // Sin lista no hay selector: la sesión sigue con su perfil.
    return null;
  }
}

async function configure(sessionId: string, what: string, call: () => Promise<unknown>): Promise<void> {
  const request: PendingRequest = { kind: 'set-model', sessionId };
  if (!uiActions.begin(request)) return;
  try {
    await call();
  } catch (err) {
    uiActions.notify(sessionId, 'warning', describeFailure(what, toCommandError(err)));
  } finally {
    uiActions.end(request);
  }
}

/** `null` quita el perfil (vuelve a `general`). */
export function setAgent(native: NativeBridge, sessionId: string, agent: string | null): Promise<void> {
  return configure(sessionId, 'No se pudo cambiar el perfil', () => native.setAgent(sessionId, agent));
}

export function setReadOnly(native: NativeBridge, sessionId: string, readOnly: boolean): Promise<void> {
  return configure(sessionId, 'No se pudo cambiar el modo de solo lectura', () =>
    native.setReadOnly(sessionId, readOnly),
  );
}

/** Cancelar un job: el cambio se ve cuando la foto lo publique. */
export async function cancelJob(native: NativeBridge, sessionId: string, jobId: string): Promise<void> {
  try {
    await native.cancelJob(sessionId, jobId);
  } catch (err) {
    uiActions.notify(sessionId, 'warning', describeFailure('No se pudo cancelar el proceso', toCommandError(err)));
  }
}

export type Loaded<T> = { ok: true; value: T } | { ok: false; message: string };

const failed = (what: string, err: unknown): { ok: false; message: string } => ({
  ok: false,
  message: describeFailure(what, toCommandError(err)),
});

/** Los cambios del árbol de trabajo de la sesión (`git.changes`, solo lectura). */
export async function loadChanges(native: NativeBridge, sessionId: string): Promise<Loaded<Changes>> {
  try {
    const changes = parseChanges(await native.gitChanges(sessionId));
    return changes ? { ok: true, value: changes } : { ok: false, message: 'La lista de cambios que llegó no se entiende.' };
  } catch (err) {
    return failed('No se pudieron leer los cambios', err);
  }
}

/** El diff de un fichero (`git.diff`, solo lectura, con los secretos ya redactados). */
export async function loadDiff(native: NativeBridge, sessionId: string, path: string): Promise<Loaded<FileDiff>> {
  try {
    const diff = parseDiff(await native.gitDiff(sessionId, path));
    return diff ? { ok: true, value: diff } : { ok: false, message: 'El diff que llegó no se entiende.' };
  } catch (err) {
    return failed('No se pudo leer el diff', err);
  }
}

/** Lo que dijo el broker o el daemon al deshacer, para una persona. */
export function describeRevertFailure(error: CommandError): string {
  if (error.kind === 'unknown') {
    return 'Resultado desconocido: no hubo respuesta y no se sabe si se deshizo. No se ha vuelto a pedir; revisa los cambios.';
  }
  if (error.kind === 'not-confirmed') return 'No se confirmó: no se ha deshecho nada.';
  if (error.kind === 'rejected') {
    if (error.code === 'BUSY') return 'La sesión tiene un turno en marcha: espera a que acabe para deshacer.';
    if (error.reason === 'peer-hosted') return 'Esta sesión la aloja una terminal: deshaz desde ella con /undo.';
    if (error.code === 'FORBIDDEN') return 'Hace falta desbloquear las aprobaciones para deshacer.';
  }
  return describeFailure('No se pudo deshacer', error);
}

/** Qué haría deshacer esos turnos: no toca nada (pero pide el broker desbloqueado). */
export async function revertPlan(native: NativeBridge, sessionId: string, turns: number): Promise<Loaded<RevertResult>> {
  try {
    const result = parseRevert(await native.revertPlan(sessionId, turns));
    return result ? { ok: true, value: result } : { ok: false, message: 'El plan que llegó no se entiende.' };
  } catch (err) {
    return { ok: false, message: describeRevertFailure(toCommandError(err)) };
  }
}

/**
 * Deshacer de verdad: abre la confirmación nativa (que relee el plan del
 * daemon) y solo sale si la persona confirma allí. `cancelled`: dijo que no.
 */
export async function revert(
  native: NativeBridge,
  sessionId: string,
  turns: number,
): Promise<Loaded<RevertResult> | { ok: false; cancelled: true }> {
  try {
    const result = parseRevert(await native.revert(sessionId, turns));
    return result ? { ok: true, value: result } : { ok: false, message: 'La respuesta que llegó no se entiende.' };
  } catch (err) {
    const error = toCommandError(err);
    if (error.kind === 'not-confirmed' && error.reason === 'cancelled') return { ok: false, cancelled: true };
    if (error.kind === 'unknown') void native.resyncSession(sessionId).catch(() => undefined);
    return { ok: false, message: describeRevertFailure(error) };
  }
}
