/**
 * M19 fase 5 — propuestas de *dreaming* (B1): `proposals.json` junto a
 * `decisions.json`. **Dreaming solo propone**: este fichero es lo único que una
 * pasada escribe; aplicar una propuesta (`apply.ts`) es de una persona.
 *
 * - Escritura atómica y Zod al leer, como el resto del estado en disco. Un
 *   fichero de un Stratum más nuevo (`schemaVersion`) no se toca: escribir
 *   lanza. Uno dañado se aparta a `.corrupt-<fecha>`.
 * - Caducan (`expiresAt`): una propuesta pendiente que pasa su plazo ya no se
 *   puede aplicar. Lo resuelto se conserva un tiempo, para auditar.
 * - Cada propuesta lleva su procedencia: las conversaciones (`evidence`) de las
 *   que sale. `create`, `correct` y `merge` no valen sin ella (B6).
 */
import { existsSync, readFileSync, renameSync } from 'fs';
import { customAlphabet } from 'nanoid';
import { z } from 'zod';
import { writeFileAtomic } from '../../config/writer.js';
import { getLogger } from '../../logging/index.js';
import { CODE_DECISION_TYPES, MEMORY_SECTIONS } from '../decisions.js';

const log = getLogger('memory').child('dreaming');

export const PROPOSALS_SCHEMA_VERSION = 1;

/** Cuántas propuestas ya resueltas (aplicadas o rechazadas) se conservan. */
export const MAX_RESOLVED_KEPT = 50;
/** Tope de propuestas pendientes a la vez. */
export const MAX_PENDING = 40;

const nano6 = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 6);

const typeSchema = z.enum([...CODE_DECISION_TYPES, ...MEMORY_SECTIONS]);
const importanceSchema = z.enum(['low', 'medium', 'high']);
const idSchema = z.string().min(1).max(80);

const evidenceSchema = z.object({
  sessionId: idSchema,
  messageId: z.string().min(1).max(40),
});
export type ProposalEvidence = z.infer<typeof evidenceSchema>;

const memoryFields = z.object({
  title: z.string().min(3).max(100),
  content: z.string().min(5).max(2000),
  summary: z.string().max(140).optional(),
  type: typeSchema,
  tags: z.array(z.string().max(40)).max(5).default([]),
  importance: importanceSchema.default('medium'),
});

/** Lo que cambia según el tipo de propuesta. */
const bodySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('create'), memory: memoryFields }),
  z.object({
    kind: z.literal('correct'),
    targetId: idSchema,
    title: z.string().min(3).max(100).optional(),
    content: z.string().min(5).max(2000).optional(),
    summary: z.string().max(140).optional(),
  }),
  z.object({
    kind: z.literal('merge'),
    /** El primero sobrevive con el contenido de `into`; los demás se olvidan. */
    targetIds: z.array(idSchema).min(2).max(5),
    into: memoryFields,
  }),
  z.object({ kind: z.literal('prune'), targetId: idSchema }),
  z.object({ kind: z.literal('reclassify'), targetId: idSchema, type: typeSchema }),
  z.object({ kind: z.literal('promote'), targetId: idSchema }),
]);
export type ProposalBody = z.infer<typeof bodySchema>;
export type ProposalKind = ProposalBody['kind'];

/** Lo que genera el modelo (sin id, fechas ni estado). */
export const proposalDraftSchema = z.intersection(
  bodySchema,
  z.object({
    rationale: z.string().min(3).max(400),
    evidence: z.array(evidenceSchema).max(5).default([]),
  }),
);
export type ProposalDraft = z.infer<typeof proposalDraftSchema>;

const statusSchema = z.enum(['pending', 'applied', 'rejected']);
export type ProposalStatus = z.infer<typeof statusSchema>;

const metaSchema = z.object({
  id: z.string().min(1),
  status: statusSchema,
  createdAt: z.string(),
  expiresAt: z.string(),
  resolvedAt: z.string().optional(),
  /** La pasada que la generó. */
  dreamId: z.string().min(1),
});

export const proposalSchema = z.intersection(proposalDraftSchema, metaSchema);
export type Proposal = z.infer<typeof proposalSchema>;

const fileSchema = z.object({
  schemaVersion: z.number().int(),
  proposals: z.array(z.unknown()),
});

export class ProposalStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProposalStoreError';
  }
}

export function newProposalId(now: Date = new Date()): string {
  const d = now.toISOString().slice(0, 10).replace(/-/g, '');
  return `prop_${d}_${nano6()}`;
}

export function newDreamId(now: Date = new Date()): string {
  const d = now.toISOString().slice(0, 10).replace(/-/g, '');
  return `dream_${d}_${nano6()}`;
}

/** ¿Pasó el plazo de una propuesta pendiente? */
export function isExpired(proposal: Pick<Proposal, 'status' | 'expiresAt'>, now: Date): boolean {
  return proposal.status === 'pending' && Date.parse(proposal.expiresAt) <= now.getTime();
}

type Outcome =
  | { kind: 'ok'; entries: unknown[] }
  | { kind: 'corrupt'; reason: string }
  | { kind: 'newer'; version: number };

export class ProposalStore {
  private warnedCorrupt = false;

  constructor(private readonly file: string) {}

  private read(): Outcome {
    if (!existsSync(this.file)) return { kind: 'ok', entries: [] };
    const raw = readFileSync(this.file, 'utf-8');
    if (!raw.trim()) return { kind: 'ok', entries: [] };
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      return { kind: 'corrupt', reason: `JSON inválido (${(err as Error).message})` };
    }
    const file = fileSchema.safeParse(parsed);
    if (!file.success) return { kind: 'corrupt', reason: 'no es una lista de propuestas' };
    if (file.data.schemaVersion > PROPOSALS_SCHEMA_VERSION) {
      return { kind: 'newer', version: file.data.schemaVersion };
    }
    return { kind: 'ok', entries: file.data.proposals };
  }

  /** Todas las propuestas que validan. Leer nunca lanza. */
  load(): Proposal[] {
    let outcome: Outcome;
    try {
      outcome = this.read();
    } catch (err) {
      log.warn('proposals read failed', { file: this.file, err });
      return [];
    }
    if (outcome.kind === 'corrupt') {
      if (!this.warnedCorrupt) {
        this.warnedCorrupt = true;
        log.warn('proposals file is corrupt; it will be set aside on the next write', {
          file: this.file,
        });
      }
      return [];
    }
    if (outcome.kind === 'newer') return [];
    return outcome.entries.flatMap((e) => {
      const p = proposalSchema.safeParse(e);
      return p.success ? [p.data] : [];
    });
  }

  /** Las pendientes y vigentes, las más recientes primero. */
  pending(now: Date = new Date()): Proposal[] {
    return this.load()
      .filter((p) => p.status === 'pending' && !isExpired(p, now))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(id: string): Proposal | undefined {
    return this.load().find((p) => p.id === id);
  }

  private entriesForWrite(): unknown[] {
    const outcome = this.read();
    if (outcome.kind === 'ok') return outcome.entries;
    if (outcome.kind === 'newer') {
      throw new ProposalStoreError(
        `${this.file} lo escribió un Stratum más nuevo (schemaVersion ${outcome.version}); no se modifica.`,
      );
    }
    const aside = `${this.file}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    renameSync(this.file, aside);
    this.warnedCorrupt = false;
    log.warn('corrupt proposals file set aside', { file: this.file, movedTo: aside });
    return [];
  }

  /**
   * Guarda `entries`: descarta las caducadas y recorta lo resuelto a las
   * `MAX_RESOLVED_KEPT` más recientes. Lo que no validan se conserva tal cual.
   */
  private write(entries: unknown[], now: Date): void {
    const kept: unknown[] = [];
    const resolved: Array<{ at: string; entry: unknown }> = [];
    for (const e of entries) {
      const p = proposalSchema.safeParse(e);
      if (!p.success) {
        kept.push(e);
      } else if (p.data.status === 'pending') {
        if (!isExpired(p.data, now)) kept.push(e);
      } else {
        resolved.push({ at: p.data.resolvedAt ?? p.data.createdAt, entry: e });
      }
    }
    resolved.sort((a, b) => b.at.localeCompare(a.at));
    kept.push(...resolved.slice(0, MAX_RESOLVED_KEPT).map((r) => r.entry));
    writeFileAtomic(
      this.file,
      JSON.stringify({ schemaVersion: PROPOSALS_SCHEMA_VERSION, proposals: kept }, null, 2),
    );
  }

  /**
   * Añade propuestas nuevas (pendientes) de una pasada, hasta `MAX_PENDING`.
   * Devuelve las guardadas.
   */
  add(
    drafts: readonly ProposalDraft[],
    opts: { dreamId: string; ttlDays: number; now?: Date },
  ): Proposal[] {
    const now = opts.now ?? new Date();
    const entries = this.entriesForWrite();
    const livePending = entries.filter((e) => {
      const p = proposalSchema.safeParse(e);
      return p.success && p.data.status === 'pending' && !isExpired(p.data, now);
    }).length;
    const room = Math.max(0, MAX_PENDING - livePending);
    const expiresAt = new Date(now.getTime() + opts.ttlDays * 86_400_000).toISOString();
    const saved: Proposal[] = drafts.slice(0, room).map((d) => ({
      ...d,
      id: newProposalId(now),
      status: 'pending' as const,
      createdAt: now.toISOString(),
      expiresAt,
      dreamId: opts.dreamId,
    }));
    if (saved.length === 0) return [];
    this.write([...entries, ...saved], now);
    return saved;
  }

  /** Marca una propuesta como aplicada o rechazada. `undefined` si no está o ya no es pendiente. */
  resolve(
    id: string,
    status: 'applied' | 'rejected',
    now: Date = new Date(),
  ): Proposal | undefined {
    const entries = this.entriesForWrite();
    const idx = entries.findIndex((e) => (e as { id?: unknown } | null)?.id === id);
    if (idx < 0) return undefined;
    const current = proposalSchema.safeParse(entries[idx]);
    if (!current.success || current.data.status !== 'pending' || isExpired(current.data, now)) {
      return undefined;
    }
    const next: Proposal = { ...current.data, status, resolvedAt: now.toISOString() };
    entries[idx] = next;
    this.write(entries, now);
    return next;
  }
}
