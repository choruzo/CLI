/** Tras una pasada, solo lo claro se aplica solo: corregir o retirar lo automático, con evidencia. */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { StratumConfigSchema } from '../../config/schema.js';
import { DecisionMemory } from '../decision-memory.js';
import type { DecisionInput } from '../decisions.js';
import { openMemoryHistory } from '../history.js';
import { undoChange } from '../revision.js';
import { MAX_AUTO_APPLIED_PER_PASS, autoApplyClear } from './auto-apply.js';
import { ProposalStore, type ProposalDraft } from './proposals.js';

const dirs: string[] = [];
const memories: DecisionMemory[] = [];
afterEach(async () => {
  for (const m of memories.splice(0)) await m.vectors.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'stratum-autoapply-'));
  dirs.push(dir);
  const config = StratumConfigSchema.parse({
    memory: {
      decisionsFile: join(dir, 'decisions.json'),
      vectorDb: join(dir, 'vectors.db'),
      embeddingDimension: 16,
    },
  });
  let n = 0;
  const memory = new DecisionMemory(config, {
    embedding: {
      embedFn: async (t) =>
        t.map(() => {
          const v = new Float32Array(16);
          v[n++ % 16] = 1;
          return v;
        }),
    },
    forceFallbackVectors: true,
  });
  memories.push(memory);
  const history = openMemoryHistory(config);
  const proposals = new ProposalStore(join(dir, 'proposals.json'));
  return { memory, history, proposals };
}

const note = (title: string, source: 'auto' | 'agent'): DecisionInput => ({
  title,
  content: `${title}: contenido`,
  type: 'profile',
  tags: [],
  importance: 'medium',
  source,
});
const evidence = [{ sessionId: 'sess_1', messageId: 'm3' }];

describe('autoApplyClear', () => {
  it('aplica la corrección y la retirada claras y deja el resto pendiente', async () => {
    const { memory, history, proposals } = setup();
    const getafe = (await memory.save(note('Vive en Getafe', 'auto'))).record;
    const curso = (await memory.save(note('Hace el curso de Indra', 'auto'))).record;
    const betta = (await memory.save(note('Tiene un betta', 'agent'))).record;
    const tren = (await memory.save(note('Usa la C4', 'auto'))).record;
    const drafts: ProposalDraft[] = [
      {
        kind: 'correct',
        targetId: getafe.id,
        title: 'Vive en Leganés',
        rationale: 'dice que se ha mudado',
        evidence,
      },
      { kind: 'prune', targetId: curso.id, rationale: 'terminó el curso', evidence },
      // Lo que guardó el agente no se toca sin la persona.
      { kind: 'prune', targetId: betta.id, rationale: 'murió', evidence },
      // Sin evidencia no es claro.
      {
        kind: 'correct',
        targetId: tren.id,
        title: 'Usa la C5',
        rationale: 'supongo',
        evidence: [],
      },
      {
        kind: 'create',
        memory: {
          title: 'Le gusta el café',
          content: 'Toma café solo.',
          type: 'profile',
          tags: [],
          importance: 'low',
        },
        rationale: 'lo dijo',
        evidence,
      },
    ];
    const fresh = proposals.add(drafts, { dreamId: 'dream_1', ttlDays: 14 });

    const applied = await autoApplyClear(fresh, { memory, history, proposals });
    expect(applied.map((p) => p.kind)).toEqual(['correct', 'prune']);
    expect(memory.get(getafe.id)?.title).toBe('Vive en Leganés');
    expect(memory.get(curso.id)).toBeUndefined();
    expect(memory.get(betta.id)).toBeDefined();
    expect(memory.get(tren.id)?.title).toBe('Usa la C4');
    expect(
      proposals
        .pending()
        .map((p) => p.kind)
        .sort(),
    ).toEqual(['correct', 'create', 'prune']);

    const changes = history.list();
    expect(changes.map((c) => [c.action, c.by, c.sessionId])).toEqual([
      ['retired', 'dreaming', 'sess_1'],
      ['corrected', 'dreaming', 'sess_1'],
    ]);
    // Se deshace igual que lo del agente.
    expect((await undoChange(memory, history, changes[0]!.id)).ok).toBe(true);
    expect(memory.get(curso.id)?.title).toBe('Hace el curso de Indra');
  });

  it(`como mucho ${MAX_AUTO_APPLIED_PER_PASS} por pasada`, async () => {
    const { memory, history, proposals } = setup();
    const drafts: ProposalDraft[] = [];
    for (let i = 0; i < MAX_AUTO_APPLIED_PER_PASS + 2; i++) {
      const r = (await memory.save(note(`Nota número ${i}`, 'auto'))).record;
      drafts.push({ kind: 'prune', targetId: r.id, rationale: 'obsoleta', evidence });
    }
    const fresh = proposals.add(drafts, { dreamId: 'dream_2', ttlDays: 14 });
    const applied = await autoApplyClear(fresh, { memory, history, proposals });
    expect(applied).toHaveLength(MAX_AUTO_APPLIED_PER_PASS);
    expect(proposals.pending()).toHaveLength(2);
  });
});
