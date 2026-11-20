/**
 * El asistente corrige o retira lo que ya no es cierto en su memoria, y la
 * persona lo deshace: `memory/history.ts`, `memory/revision.ts` y las tools
 * `correct_memory`/`retire_memory`.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { ToolContext } from '../agent/types.js';
import { ASSISTANT_TOOLS, COMPANION_TOOLS } from '../agent/presets.js';
import { StratumConfigSchema, type StratumConfig } from '../config/schema.js';
import { callEffects } from '../tools/environments.js';
import {
  FREE_CHANGES_PER_SESSION,
  correctMemoryTool,
  resetRevisionCountersForTests,
  retireMemoryTool,
} from '../tools/memory/revise-memory.js';
import {
  DecisionMemory,
  _resetDecisionMemoryCache,
  _setDecisionMemory,
} from './decision-memory.js';
import type { DecisionInput } from './decisions.js';
import { MAX_HISTORY_ENTRIES, MemoryHistoryStore, openMemoryHistory } from './history.js';
import { correctMemory, retireMemory, undoChange } from './revision.js';

const dirs: string[] = [];
const memories: DecisionMemory[] = [];
afterEach(async () => {
  for (const m of memories.splice(0)) await m.vectors.close();
  _resetDecisionMemoryCache();
  resetRevisionCountersForTests();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup(): { config: StratumConfig; memory: DecisionMemory; history: MemoryHistoryStore } {
  const dir = mkdtempSync(join(tmpdir(), 'stratum-revision-'));
  dirs.push(dir);
  const config = StratumConfigSchema.parse({
    memory: {
      decisionsFile: join(dir, 'decisions.json'),
      vectorDb: join(dir, 'vectors.db'),
      embeddingDimension: 4,
    },
  });
  // Un vector distinto por texto: sin dedup entre recuerdos distintos.
  let n = 0;
  const memory = new DecisionMemory(config, {
    embedding: {
      embedFn: async (t) =>
        t.map(() => {
          const v = new Float32Array(4);
          v[n++ % 4] = 1;
          return v;
        }),
    },
    forceFallbackVectors: true,
  });
  _setDecisionMemory(config, memory);
  memories.push(memory);
  return { config, memory, history: openMemoryHistory(config) };
}

const getafe: DecisionInput = {
  title: 'Vive en Getafe',
  content: 'El usuario vive en Getafe (Madrid).',
  summary: 'Vive en Getafe',
  type: 'profile',
  tags: ['ubicación'],
  importance: 'high',
  source: 'auto',
};

describe('correctMemory y undoChange', () => {
  it('corrige, deja el recuerdo entero en el historial y lo deshace', async () => {
    const { memory, history } = setup();
    const { record } = await memory.save(getafe);
    const r = await correctMemory(memory, history, {
      id: record.id,
      title: 'Vive en Leganés',
      content: 'El usuario se ha mudado a Leganés (Madrid).',
      summary: 'Vive en Leganés',
      reason: 'el usuario dice que se ha mudado',
      sessionId: 'sess_1',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(memory.get(record.id)).toMatchObject({ title: 'Vive en Leganés', type: 'profile' });
    expect(r.change).toMatchObject({
      action: 'corrected',
      decisionId: record.id,
      by: 'agent',
      sessionId: 'sess_1',
      before: { title: 'Vive en Getafe', content: getafe.content },
      after: { title: 'Vive en Leganés' },
    });
    expect(history.list()).toHaveLength(1);

    const undo = await undoChange(memory, history, r.change.id);
    expect(undo.ok).toBe(true);
    expect(memory.get(record.id)).toMatchObject({
      title: 'Vive en Getafe',
      summary: 'Vive en Getafe',
    });
    expect(history.get(r.change.id)?.undoneAt).toBeDefined();

    const again = await undoChange(memory, history, r.change.id);
    expect(again).toMatchObject({
      ok: false,
      error: expect.stringContaining('ya estaba deshecho'),
    });
  });

  it('no deshace si el recuerdo ha cambiado después: no pisa lo nuevo', async () => {
    const { memory, history } = setup();
    const { record } = await memory.save(getafe);
    const r = await correctMemory(memory, history, {
      id: record.id,
      content: 'El usuario vive en Leganés.',
      reason: 'se ha mudado',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    await new Promise((res) => setTimeout(res, 5));
    await memory.edit(record.id, { content: 'El usuario vive en Alcorcón.' });
    const undo = await undoChange(memory, history, r.change.id);
    expect(undo).toMatchObject({
      ok: false,
      error: expect.stringContaining('ha cambiado después'),
    });
    expect(memory.get(record.id)?.content).toBe('El usuario vive en Alcorcón.');
  });

  it('una corrección que no cambia nada, o de un id que no está, no hace nada', async () => {
    const { memory, history } = setup();
    const { record } = await memory.save(getafe);
    expect(
      await correctMemory(memory, history, { id: record.id, title: getafe.title, reason: 'x' }),
    ).toMatchObject({ ok: false, error: expect.stringContaining('no cambia nada') });
    expect(
      await correctMemory(memory, history, { id: 'dec_nope', title: 'Otro', reason: 'x' }),
    ).toMatchObject({ ok: false, error: expect.stringContaining('dec_nope') });
    expect(history.list()).toEqual([]);
  });
});

describe('retireMemory y undoChange', () => {
  it('retira de la memoria y del recall, y deshacer lo vuelve a poner con su id', async () => {
    const { memory, history } = setup();
    const { record } = await memory.save(getafe);
    const r = await retireMemory(memory, history, { id: record.id, reason: 'ya no aplica' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(memory.get(record.id)).toBeUndefined();
    expect(memory.list()).toEqual([]);
    expect(r.change.before).toMatchObject({ id: record.id, title: 'Vive en Getafe' });

    const undo = await undoChange(memory, history, r.change.id);
    expect(undo.ok).toBe(true);
    expect(memory.get(record.id)).toMatchObject({ title: 'Vive en Getafe', source: 'auto' });
    expect(await memory.vectors.has(record.embedding_ref)).toBe(true);
  });

  it('no vuelve a poner un recuerdo que ya está', async () => {
    const { memory, history } = setup();
    const { record } = await memory.save(getafe);
    const r = await retireMemory(memory, history, { id: record.id, reason: 'ya no aplica' });
    if (!r.ok) throw new Error('no retiró');
    await memory.reinstate(record);
    const undo = await undoChange(memory, history, r.change.id);
    expect(undo).toMatchObject({ ok: false, error: expect.stringContaining('ya está') });
  });
});

describe('memory-history.json', () => {
  it('con un historial de un Stratum más nuevo no se cambia la memoria (sin rastro no hay cambio)', async () => {
    const { memory, history } = setup();
    const { record } = await memory.save(getafe);
    writeFileSync(history.file, JSON.stringify({ schemaVersion: 99, changes: [] }));
    const r = await retireMemory(memory, history, { id: record.id, reason: 'ya no aplica' });
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining('más nuevo') });
    expect(memory.get(record.id)).toBeDefined();
    expect(JSON.parse(readFileSync(history.file, 'utf-8'))).toEqual({
      schemaVersion: 99,
      changes: [],
    });
  });

  it('se queda con los más recientes y aparta uno dañado al escribir', async () => {
    const { history } = setup();
    writeFileSync(history.file, '{ esto no es JSON');
    expect(history.list()).toEqual([]);
    const base = {
      action: 'retired' as const,
      by: 'agent' as const,
      reason: 'r',
      before: { id: 'dec_x' },
    };
    for (let i = 0; i < MAX_HISTORY_ENTRIES + 3; i++) {
      history.add({ ...base, decisionId: `dec_${i}` }, new Date(Date.UTC(2026, 10, 1, 0, i)));
    }
    const list = history.list();
    expect(list).toHaveLength(MAX_HISTORY_ENTRIES);
    expect(list[0]?.decisionId).toBe(`dec_${MAX_HISTORY_ENTRIES + 2}`);
  });
});

describe('correct_memory y retire_memory (tools)', () => {
  const ctxOf = (config: StratumConfig, sessionId = 'sess_a') =>
    ({ config, sessionId }) as unknown as ToolContext;

  it('las tienen assistant y companion; escriben memoria (callEffects)', () => {
    for (const name of ['correct_memory', 'retire_memory']) {
      expect(ASSISTANT_TOOLS).toContain(name);
      expect(COMPANION_TOOLS).toContain(name);
      expect(callEffects(name, {})).toMatchObject({ known: true, mutating: true, targets: [] });
    }
  });

  it('sin confirmación solo lo de la extracción automática y hasta el tope por sesión', async () => {
    const { config, memory } = setup();
    const auto = await memory.save(getafe);
    const byAgent = await memory.save({ ...getafe, title: 'Hermana Marta', source: 'agent' });
    const legacy = await memory.save({ ...getafe, title: 'Algo antiguo', source: undefined });
    const ctx = ctxOf(config);
    expect(retireMemoryTool.isDestructive!({ id: auto.record.id, reason: 'x' }, ctx)).toBe(false);
    expect(retireMemoryTool.isDestructive!({ id: byAgent.record.id, reason: 'x' }, ctx)).toBe(true);
    expect(retireMemoryTool.isDestructive!({ id: legacy.record.id, reason: 'x' }, ctx)).toBe(true);

    for (let i = 0; i < FREE_CHANGES_PER_SESSION; i++) {
      const r = await correctMemoryTool.execute(
        {
          id: auto.record.id,
          content: `El usuario vive en Getafe, versión ${i}.`,
          reason: 'matiz',
        },
        ctx,
      );
      expect(r.ok).toBe(true);
    }
    expect(correctMemoryTool.isDestructive!({ id: auto.record.id, reason: 'x' }, ctx)).toBe(true);
    // El tope es por sesión.
    expect(
      correctMemoryTool.isDestructive!(
        { id: auto.record.id, reason: 'x' },
        ctxOf(config, 'sess_b'),
      ),
    ).toBe(false);
  });

  it('un id que no está se veta antes de preguntar', () => {
    const { config } = setup();
    const r = retireMemoryTool.preflight!(
      { id: 'dec_nope', reason: 'ya no aplica' },
      ctxOf(config),
    );
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining('recall_decisions') });
  });

  it('corregir y retirar dicen el cambio que se puede deshacer', async () => {
    const { config, memory } = setup();
    const { record } = await memory.save(getafe);
    const c = await correctMemoryTool.execute(
      { id: record.id, summary: 'Vive en Getafe, cerca de la C4', reason: 'lo dice el usuario' },
      ctxOf(config),
    );
    expect(c).toMatchObject({ ok: true, output: expect.stringMatching(/corregido.*cambio chg_/) });
    const r = await retireMemoryTool.execute(
      { id: record.id, reason: 'se ha mudado' },
      ctxOf(config),
    );
    expect(r).toMatchObject({
      ok: true,
      output: expect.stringMatching(/retirado: «Vive en Getafe».*chg_/),
    });
    expect(
      openMemoryHistory(config)
        .list()
        .map((ch) => ch.action),
    ).toEqual(['retired', 'corrected']);
  });

  it('corregir sin nada que cambiar no valida', () => {
    expect(correctMemoryTool.schema.safeParse({ id: 'dec_x', reason: 'algo' }).success).toBe(false);
  });
});
