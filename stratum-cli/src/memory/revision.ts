/**
 * El agente corrige o retira lo que ya no es cierto en su memoria, y la
 * persona lo deshace. Cada cambio deja en `memory-history.json`
 * (`memory/history.ts`) el recuerdo entero tal como estaba.
 *
 * Aquí no se decide **quién** puede cambiar qué: eso es de las tools
 * (`tools/memory/revise-memory.ts`), que piden confirmación para lo que no
 * salió de la extracción automática. Esto solo hace el cambio y su rastro.
 */
import type { DecisionMemory } from './decision-memory.js';
import type { DecisionRecord } from './decisions.js';
import { MemoryHistoryError, type MemoryChange, type MemoryHistoryStore } from './history.js';

export type RevisionResult =
  | { ok: true; change: MemoryChange; record?: DecisionRecord }
  | { ok: false; error: string };

export interface CorrectionInput {
  id: string;
  /** Quién corrige; por defecto, el agente. */
  by?: 'agent' | 'dreaming';
  title?: string;
  content?: string;
  summary?: string;
  reason: string;
  sessionId?: string;
}

export interface RetirementInput {
  id: string;
  by?: 'agent' | 'dreaming';
  reason: string;
  sessionId?: string;
}

function failure(err: unknown): RevisionResult {
  if (err instanceof MemoryHistoryError) return { ok: false, error: err.message };
  return { ok: false, error: `no se pudo cambiar la memoria: ${(err as Error).message}` };
}

/**
 * Corrige un recuerdo. Si el historial no se puede escribir después de
 * cambiarlo, el recuerdo vuelve a como estaba: sin rastro no hay cambio.
 */
export async function correctMemory(
  memory: DecisionMemory,
  history: MemoryHistoryStore,
  input: CorrectionInput,
): Promise<RevisionResult> {
  try {
    history.assertWritable();
    const before = memory.get(input.id);
    if (!before) return { ok: false, error: `no hay ningún recuerdo con id ${input.id}` };
    const patch = {
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.content !== undefined ? { content: input.content } : {}),
      ...(input.summary !== undefined ? { summary: input.summary } : {}),
    };
    const unchanged =
      (patch.title ?? before.title) === before.title &&
      (patch.content ?? before.content) === before.content &&
      (patch.summary ?? before.summary ?? '') === (before.summary ?? '');
    if (unchanged) return { ok: false, error: 'la corrección no cambia nada del recuerdo' };

    const after = await memory.edit(input.id, patch);
    if (!after) return { ok: false, error: `no se pudo corregir ${input.id}` };
    try {
      const change = history.add({
        action: 'corrected',
        decisionId: input.id,
        by: input.by ?? 'agent',
        reason: input.reason,
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        before: { ...before },
        after: {
          title: after.title,
          content: after.content,
          ...(after.summary !== undefined ? { summary: after.summary } : {}),
          ...(after.updatedAt !== undefined ? { updatedAt: after.updatedAt } : {}),
        },
      });
      return { ok: true, change, record: after };
    } catch (err) {
      await memory.edit(input.id, {
        title: before.title,
        content: before.content,
        summary: before.summary ?? '',
      });
      return failure(err);
    }
  } catch (err) {
    return failure(err);
  }
}

/**
 * Retira un recuerdo: sale de `decisions.json` y del índice, y queda entero en
 * el historial. Si el historial falla, el recuerdo vuelve.
 */
export async function retireMemory(
  memory: DecisionMemory,
  history: MemoryHistoryStore,
  input: RetirementInput,
): Promise<RevisionResult> {
  try {
    history.assertWritable();
    const before = memory.get(input.id);
    if (!before) return { ok: false, error: `no hay ningún recuerdo con id ${input.id}` };
    if (!(await memory.remove(input.id))) {
      return { ok: false, error: `no se pudo retirar ${input.id}` };
    }
    try {
      const change = history.add({
        action: 'retired',
        decisionId: input.id,
        by: input.by ?? 'agent',
        reason: input.reason,
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        before: { ...before },
      });
      return { ok: true, change };
    } catch (err) {
      await memory.reinstate(before);
      return failure(err);
    }
  } catch (err) {
    return failure(err);
  }
}

/** ¿Se puede deshacer ya? Lo mismo que comprueba `undoChange`, sin tocar nada. */
export function isUndoable(memory: DecisionMemory, change: MemoryChange): boolean {
  if (change.undoneAt) return false;
  const current = memory.get(change.decisionId);
  if (change.action === 'retired') return current === undefined;
  return current !== undefined && current.updatedAt === change.after?.updatedAt;
}

/**
 * Deshace un cambio. Solo si el recuerdo sigue como lo dejó: si alguien lo ha
 * cambiado, borrado o vuelto a poner después, no se pisa nada.
 */
export async function undoChange(
  memory: DecisionMemory,
  history: MemoryHistoryStore,
  changeId: string,
): Promise<RevisionResult> {
  try {
    const change = history.get(changeId);
    if (!change) return { ok: false, error: `no hay ningún cambio con id ${changeId}` };
    if (change.undoneAt) return { ok: false, error: `el cambio ${changeId} ya estaba deshecho` };
    const before = change.before as unknown as DecisionRecord;
    if (before.id !== change.decisionId) {
      return { ok: false, error: `el cambio ${changeId} no guarda el recuerdo que cambió` };
    }
    const current = memory.get(change.decisionId);

    if (change.action === 'corrected') {
      if (!current) return { ok: false, error: `el recuerdo ${change.decisionId} ya no está` };
      if (current.updatedAt !== change.after?.updatedAt) {
        return {
          ok: false,
          error: `el recuerdo ${change.decisionId} ha cambiado después; no se deshace para no pisarlo`,
        };
      }
      const restored = await memory.edit(change.decisionId, {
        title: before.title,
        content: before.content,
        summary: before.summary ?? '',
      });
      if (!restored) return { ok: false, error: `no se pudo restaurar ${change.decisionId}` };
      const undone = history.markUndone(changeId) ?? change;
      return { ok: true, change: undone, record: restored };
    }

    if (current) {
      return { ok: false, error: `el recuerdo ${change.decisionId} ya está en la memoria` };
    }
    if (!(await memory.reinstate(before))) {
      return { ok: false, error: `no se pudo volver a poner ${change.decisionId}` };
    }
    const undone = history.markUndone(changeId) ?? change;
    return { ok: true, change: undone, record: memory.get(change.decisionId) ?? before };
  } catch (err) {
    return failure(err);
  }
}
