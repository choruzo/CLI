/**
 * M19 fase 5 — aplicar o rechazar una propuesta de *dreaming*. Es **el único
 * sitio** del dreaming que escribe en la memoria, y solo lo llama quien tiene
 * la autoridad: una persona, desde `stratum memory proposals apply` (o, más
 * adelante, un inspector). Una pasada de dreaming (`dream.ts`) no importa este
 * fichero (lo fija `architecture.test.ts`).
 *
 * Aplicar re-valida todo contra el estado de ahora: la propuesta puede haber
 * caducado, o su objetivo haber cambiado desde que se generó.
 */
import type { DecisionMemory } from '../decision-memory.js';
import {
  CODE_DECISION_TYPES,
  MEMORY_SECTIONS,
  type DecisionRecord,
  type MemoryTaxonomy,
} from '../decisions.js';
import { isExpired, type Proposal, type ProposalStore } from './proposals.js';

export type ApplyResult = { ok: true; message: string } | { ok: false; message: string };

function typesOf(taxonomy: MemoryTaxonomy): readonly string[] {
  return taxonomy === 'sections' ? MEMORY_SECTIONS : CODE_DECISION_TYPES;
}

function describe(r: DecisionRecord): string {
  return `${r.id} «${r.title}»`;
}

async function perform(
  proposal: Proposal,
  memory: DecisionMemory,
  taxonomy: MemoryTaxonomy,
): Promise<ApplyResult> {
  const allowed = typesOf(taxonomy);
  const find = (id: string): DecisionRecord | undefined => memory.list().find((r) => r.id === id);
  const missing = (id: string): ApplyResult => ({
    ok: false,
    message: `La decisión ${id} ya no existe: la propuesta no se puede aplicar.`,
  });

  switch (proposal.kind) {
    case 'create': {
      if (!allowed.includes(proposal.memory.type)) {
        return { ok: false, message: `El tipo «${proposal.memory.type}» no es de esta memoria.` };
      }
      const result = await memory.save(
        {
          ...proposal.memory,
          source: 'auto',
          ...(proposal.evidence[0] ? { session_id: proposal.evidence[0].sessionId } : {}),
        },
        {
          source: 'user',
          ...(proposal.evidence[0] ? { sessionId: proposal.evidence[0].sessionId } : {}),
        },
      );
      return result.deduped
        ? {
            ok: true,
            message: `Ya existía algo casi igual (${result.duplicateOf}); no se creó nada nuevo.`,
          }
        : { ok: true, message: `Creada ${describe(result.record)}.` };
    }
    case 'correct': {
      const target = find(proposal.targetId);
      if (!target) return missing(proposal.targetId);
      const updated = await memory.edit(proposal.targetId, {
        ...(proposal.title !== undefined ? { title: proposal.title } : {}),
        ...(proposal.content !== undefined ? { content: proposal.content } : {}),
        ...(proposal.summary !== undefined ? { summary: proposal.summary } : {}),
      });
      return updated
        ? { ok: true, message: `Corregida ${describe(updated)}.` }
        : missing(proposal.targetId);
    }
    case 'merge': {
      if (!allowed.includes(proposal.into.type)) {
        return { ok: false, message: `El tipo «${proposal.into.type}» no es de esta memoria.` };
      }
      for (const id of proposal.targetIds) if (!find(id)) return missing(id);
      const [survivor, ...rest] = proposal.targetIds as [string, ...string[]];
      const updated = await memory.edit(survivor, {
        title: proposal.into.title,
        content: proposal.into.content,
        type: proposal.into.type,
        tags: proposal.into.tags,
        importance: proposal.into.importance,
        ...(proposal.into.summary !== undefined ? { summary: proposal.into.summary } : {}),
      });
      if (!updated) return missing(survivor);
      for (const id of rest) await memory.remove(id);
      return {
        ok: true,
        message: `Fusionadas ${proposal.targetIds.length} decisiones en ${describe(updated)}.`,
      };
    }
    case 'prune': {
      const target = find(proposal.targetId);
      if (!target) return missing(proposal.targetId);
      await memory.remove(proposal.targetId);
      return { ok: true, message: `Olvidada ${describe(target)}.` };
    }
    case 'reclassify': {
      if (!allowed.includes(proposal.type)) {
        return { ok: false, message: `El tipo «${proposal.type}» no es de esta memoria.` };
      }
      const updated = await memory.reclassify(proposal.targetId, { type: proposal.type });
      return updated
        ? { ok: true, message: `${describe(updated)} pasa a ${proposal.type}.` }
        : missing(proposal.targetId);
    }
    case 'promote': {
      const updated = await memory.edit(proposal.targetId, { importance: 'high' });
      return updated
        ? {
            ok: true,
            message: `${describe(updated)} sube a importancia alta (encabeza el índice).`,
          }
        : missing(proposal.targetId);
    }
  }
}

/**
 * Aplica una propuesta pendiente y vigente. Si no se puede (caducó, el objetivo
 * cambió, el tipo no vale), la propuesta queda como estaba: pendiente.
 */
export async function applyProposal(
  id: string,
  deps: {
    memory: DecisionMemory;
    proposals: ProposalStore;
    taxonomy: MemoryTaxonomy;
    now?: Date;
  },
): Promise<ApplyResult> {
  const now = deps.now ?? new Date();
  const proposal = deps.proposals.get(id);
  if (!proposal) return { ok: false, message: `No hay ninguna propuesta ${id}.` };
  if (proposal.status !== 'pending') {
    return {
      ok: false,
      message: `La propuesta ${id} ya está ${proposal.status === 'applied' ? 'aplicada' : 'rechazada'}.`,
    };
  }
  if (isExpired(proposal, now)) return { ok: false, message: `La propuesta ${id} caducó.` };
  const result = await perform(proposal, deps.memory, deps.taxonomy);
  if (result.ok) deps.proposals.resolve(id, 'applied', now);
  return result;
}

/** Rechaza una propuesta pendiente: no toca la memoria. */
export function rejectProposal(
  id: string,
  deps: { proposals: ProposalStore; now?: Date },
): ApplyResult {
  const proposal = deps.proposals.get(id);
  if (!proposal) return { ok: false, message: `No hay ninguna propuesta ${id}.` };
  const done = deps.proposals.resolve(id, 'rejected', deps.now);
  return done
    ? { ok: true, message: `Propuesta ${id} rechazada.` }
    : { ok: false, message: `La propuesta ${id} ya no está pendiente.` };
}
