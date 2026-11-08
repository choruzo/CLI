/**
 * M19 fase 5 — dreaming por el protocolo (`memory.proposals|dream|applyProposal|
 * rejectProposal`). El daemon no decide nada aquí: pone la memoria, las
 * conversaciones de su ámbito y el modelo, y deja a `memory/dreaming/` hacer lo
 * suyo. **Pedir una pasada solo propone**; lo único que cambia la memoria es
 * aplicar una propuesta, que pide una persona desde un inspector.
 */
import { getDecisionMemory } from '../memory/decision-memory.js';
import { applyProposal, rejectProposal } from '../memory/dreaming/apply.js';
import { dream } from '../memory/dreaming/dream.js';
import { openDreamingFiles } from '../memory/dreaming/files.js';
import { resolveDreamingModel, type DreamingModel } from '../memory/dreaming/model.js';
import type { Proposal } from '../memory/dreaming/proposals.js';
import type { MemoryTaxonomy } from '../memory/decisions.js';
import type { StratumConfig } from '../config/schema.js';
import { getLogger } from '../logging/index.js';
import type { ProtocolDreamResult, ProtocolProposal } from '../protocol/index.js';
import { ProviderRouter } from '../providers/router.js';
import { redactText } from '../security/redact-output.js';
import { listSources, type TranscriptScope } from '../transcripts/search.js';

const log = getLogger('daemon').child('dreaming');

/** Sobre qué memoria actúa una petición: su config, su clasificación y sus conversaciones. */
export interface DreamTarget {
  /** La config de esa memoria (`memoryConfigFor`): sus ficheros y su redacción. */
  memory: StratumConfig;
  taxonomy: MemoryTaxonomy;
  scope: TranscriptScope;
  /** La config de la que sale el modelo (la del daemon). */
  base: StratumConfig;
}

/** Una propuesta como la ve un cliente: sin ficheros, redactada y con los títulos de ahora. */
export function toProtocolProposal(
  p: Proposal,
  titleOf: (id: string) => string | undefined,
  redact: (text: string) => string,
): ProtocolProposal {
  const targetIds = p.kind === 'create' ? [] : p.kind === 'merge' ? p.targetIds : [p.targetId];
  const out: ProtocolProposal = {
    id: p.id,
    kind: p.kind,
    createdAt: p.createdAt,
    expiresAt: p.expiresAt,
    rationale: redact(p.rationale),
    evidence: p.evidence,
    targets: targetIds.map((id) => ({ id, title: redact(titleOf(id) ?? '') })),
  };
  const text = (value: string | undefined) => (value === undefined ? undefined : redact(value));
  const set = <K extends 'title' | 'content' | 'summary' | 'type' | 'importance'>(
    key: K,
    value: string | undefined,
  ) => {
    if (value !== undefined) out[key] = value;
  };
  switch (p.kind) {
    case 'create':
      set('title', text(p.memory.title));
      set('content', text(p.memory.content));
      set('summary', text(p.memory.summary));
      set('type', p.memory.type);
      set('importance', p.memory.importance);
      break;
    case 'correct':
      set('title', text(p.title));
      set('content', text(p.content));
      set('summary', text(p.summary));
      break;
    case 'merge':
      set('title', text(p.into.title));
      set('content', text(p.into.content));
      set('summary', text(p.into.summary));
      set('type', p.into.type);
      set('importance', p.into.importance);
      break;
    case 'reclassify':
      set('type', p.type);
      break;
    default:
      break;
  }
  return out;
}

/** Cómo se resuelve el modelo de una pasada. Inyectable para tests. */
export type DreamingModelFactory = (base: StratumConfig) => DreamingModel;

export class DreamingService {
  /** Una pasada a la vez por memoria. */
  private readonly running = new Set<string>();
  private readonly abort = new AbortController();

  /** `sessionsDir`: las conversaciones guardadas del daemon, o `null` si no guarda ninguna. */
  constructor(
    private readonly sessionsDir: string | null,
    private readonly modelFor?: DreamingModelFactory,
  ) {}

  /** Corta las pasadas en vuelo (apagado del daemon). */
  close(): void {
    this.abort.abort();
  }

  private key(target: DreamTarget): string {
    return target.memory.memory.decisionsFile;
  }

  private titles(target: DreamTarget): (id: string) => string | undefined {
    const byId = new Map(
      getDecisionMemory(target.memory)
        .list()
        .map((d) => [d.id, d.title]),
    );
    return (id) => byId.get(id);
  }

  list(target: DreamTarget): ProtocolProposal[] {
    const redact = (text: string) => redactText(text, target.memory);
    const titleOf = this.titles(target);
    return openDreamingFiles(target.memory)
      .proposals.pending()
      .map((p) => toProtocolProposal(p, titleOf, redact));
  }

  /** `true` si hay una pasada en marcha sobre esa memoria. */
  isRunning(target: DreamTarget): boolean {
    return this.running.has(this.key(target));
  }

  async run(target: DreamTarget, opts: { force?: boolean } = {}): Promise<ProtocolDreamResult> {
    const skipped = (
      reason: NonNullable<ProtocolDreamResult['reason']>,
      message: string,
    ): ProtocolDreamResult => ({
      status: 'skipped',
      reason,
      message,
      proposals: [],
      discarded: 0,
      tokens: null,
    });
    let model: DreamingModel;
    if (this.modelFor) {
      model = this.modelFor(target.base);
    } else {
      try {
        model = resolveDreamingModel(target.base, new ProviderRouter(target.base));
      } catch {
        return skipped('no-model', 'There is no provider configured to run dreaming.');
      }
    }
    if (!model.ok) return skipped('no-model', model.message);

    const key = this.key(target);
    this.running.add(key);
    try {
      const files = openDreamingFiles(target.memory);
      const memory = getDecisionMemory(target.memory);
      const redact = (text: string) => redactText(text, target.memory);
      const result = await dream({
        notes: () => memory.list(),
        proposals: files.proposals,
        state: files.state,
        taxonomy: target.taxonomy,
        sources: this.sessionsDir ? listSources(this.sessionsDir, target.scope) : [],
        provider: model.provider,
        providerName: model.providerName,
        model: model.model,
        config: target.base.memory.dreaming,
        redact,
        cancelSignal: this.abort.signal,
        ...(opts.force ? { force: true } : {}),
      });
      if (!result.ok) {
        const failed = result.reason === 'model-failed' || result.reason === 'unparsable';
        return {
          status: failed ? 'failed' : 'skipped',
          reason: result.reason === 'cancelled' ? 'cancelled' : result.reason,
          message: redact(result.message),
          proposals: [],
          discarded: 0,
          tokens: null,
        };
      }
      const titleOf = this.titles(target);
      // Ninguna línea de log lleva texto de la memoria ni de las conversaciones.
      log.info('dream requested', {
        proposals: result.proposals.length,
        discarded: result.discarded,
        messages: result.considered.messages,
      });
      return {
        status: 'done',
        message: `${result.proposals.length} proposals from ${result.considered.messages} new messages.`,
        proposals: result.proposals.map((p) => toProtocolProposal(p, titleOf, redact)),
        discarded: result.discarded,
        tokens: result.tokens,
      };
    } finally {
      this.running.delete(key);
    }
  }

  async apply(
    target: DreamTarget,
    proposalId: string,
  ): Promise<{ applied: boolean; message: string }> {
    const result = await applyProposal(proposalId, {
      memory: getDecisionMemory(target.memory),
      proposals: openDreamingFiles(target.memory).proposals,
      taxonomy: target.taxonomy,
    });
    return { applied: result.ok, message: redactText(result.message, target.memory) };
  }

  reject(target: DreamTarget, proposalId: string): { rejected: boolean; message: string } {
    const result = rejectProposal(proposalId, {
      proposals: openDreamingFiles(target.memory).proposals,
    });
    return { rejected: result.ok, message: redactText(result.message, target.memory) };
  }
}
