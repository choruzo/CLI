/**
 * Tras una pasada de dreaming, lo **claro** se aplica solo (2026-11-20,
 * decidido por el usuario): corregir o retirar un recuerdo que ya no es cierto.
 * Lo demás (crear, fusionar, reclasificar, promover) sigue siendo una propuesta
 * que aplica una persona.
 *
 * «Claro» es, a la vez:
 *  - una corrección (`correct`) o una retirada (`prune`);
 *  - con evidencia: mensajes de una conversación que la pasada vio de verdad
 *    (`dream.ts` ya descarta la que no);
 *  - sobre un recuerdo que salió de la extracción automática (`source: 'auto'`):
 *    lo que guardó el agente a propósito, a menudo porque la persona se lo pidió,
 *    no se toca sin ella. Es la misma regla que las tools `correct_memory` y
 *    `retire_memory`.
 *
 * Como mucho `MAX_AUTO_APPLIED_PER_PASS` por pasada. Va por `memory/revision.ts`,
 * así que cada cambio deja el recuerdo entero en el historial (`by: 'dreaming'`)
 * y se deshace igual que los del agente. La pasada (`dream.ts`) sigue sin
 * escribir la memoria: esto lo llama quien la lanza (`DreamingService.run` y
 * `stratum memory dream`).
 */
import type { DecisionMemory } from '../decision-memory.js';
import type { MemoryHistoryStore } from '../history.js';
import { correctMemory, retireMemory } from '../revision.js';
import type { Proposal, ProposalStore } from './proposals.js';

export const MAX_AUTO_APPLIED_PER_PASS = 5;

export interface AutoApplyDeps {
  memory: DecisionMemory;
  history: MemoryHistoryStore;
  proposals: ProposalStore;
}

/** ¿Es de las que se aplican solas? No mira si cabe en el tope. */
export function isClearProposal(proposal: Proposal, memory: DecisionMemory): boolean {
  if (proposal.status !== 'pending') return false;
  if (proposal.kind !== 'correct' && proposal.kind !== 'prune') return false;
  if (proposal.evidence.length === 0) return false;
  return memory.get(proposal.targetId)?.source === 'auto';
}

/**
 * Aplica las propuestas claras de una pasada y las marca como aplicadas.
 * Devuelve las que aplicó. Un fallo en una no para las demás y la deja
 * pendiente, para que la vea una persona.
 */
export async function autoApplyClear(
  fresh: readonly Proposal[],
  deps: AutoApplyDeps,
): Promise<Proposal[]> {
  const applied: Proposal[] = [];
  for (const proposal of fresh) {
    if (applied.length >= MAX_AUTO_APPLIED_PER_PASS) break;
    if (!isClearProposal(proposal, deps.memory)) continue;
    if (proposal.kind !== 'correct' && proposal.kind !== 'prune') continue;
    const sessionId = proposal.evidence[0]?.sessionId;
    const common = {
      id: proposal.targetId,
      by: 'dreaming' as const,
      reason: proposal.rationale,
      ...(sessionId ? { sessionId } : {}),
    };
    const result =
      proposal.kind === 'correct'
        ? await correctMemory(deps.memory, deps.history, {
            ...common,
            ...(proposal.title !== undefined ? { title: proposal.title } : {}),
            ...(proposal.content !== undefined ? { content: proposal.content } : {}),
            ...(proposal.summary !== undefined ? { summary: proposal.summary } : {}),
          })
        : await retireMemory(deps.memory, deps.history, common);
    if (!result.ok) continue;
    const resolved = deps.proposals.resolve(proposal.id, 'applied');
    applied.push(resolved ?? proposal);
  }
  return applied;
}
