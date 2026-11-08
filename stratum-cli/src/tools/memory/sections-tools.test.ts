/** M19 fase 1 — las tools de `assistant` y `companion` hablan en secciones; la de código, no. */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { ToolContext } from '../../agent/types.js';
import { StratumConfigSchema } from '../../config/schema.js';
import {
  DecisionMemory,
  _resetDecisionMemoryCache,
  _setDecisionMemory,
} from '../../memory/decision-memory.js';
import { recallDecisionsTool, recallMemoryTool } from './recall-decisions.js';
import { storeDecisionTool, storeMemoryTool } from './store-decision.js';

const dirs: string[] = [];
const memories: DecisionMemory[] = [];
afterEach(async () => {
  for (const m of memories.splice(0)) await m.vectors.close();
  _resetDecisionMemoryCache();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'sections-tools-'));
  dirs.push(dir);
  const config = StratumConfigSchema.parse({
    memory: {
      decisionsFile: join(dir, 'decisions.json'),
      vectorDb: join(dir, 'vectors.db'),
      embeddingDimension: 4,
    },
  });
  const memory = new DecisionMemory(config, {
    embedding: { embedFn: async (t) => t.map(() => new Float32Array([1, 0, 0, 0])) },
    forceFallbackVectors: true,
  });
  _setDecisionMemory(config, memory);
  memories.push(memory);
  return { ctx: { config } as unknown as ToolContext, memory };
}

const base = {
  title: 'Lucía, su hermana',
  content: 'Su hermana Lucía vive en Valencia.',
  tags: ['familia'],
  importance: 'medium',
};

describe('store_decision con secciones', () => {
  it('guarda sección y resumen', async () => {
    const { ctx, memory } = setup();
    const r = await storeMemoryTool.execute(
      { ...base, type: 'person', summary: 'Lucía (hermana), en Valencia' },
      ctx,
    );
    expect(r.ok).toBe(true);
    expect(memory.list()[0]).toMatchObject({
      type: 'person',
      summary: 'Lucía (hermana), en Valencia',
    });
  });

  it('sin tipo, topic (B2): no falla', async () => {
    const { ctx, memory } = setup();
    const r = await storeMemoryTool.execute(base, ctx);
    expect(r.ok).toBe(true);
    expect(memory.list()[0]?.type).toBe('topic');
  });

  it('la de código no acepta una sección, y la de secciones no acepta un tipo de código', () => {
    expect(storeDecisionTool.schema.safeParse({ ...base, type: 'profile' }).success).toBe(false);
    expect(storeDecisionTool.schema.safeParse({ ...base, type: 'bug_fix' }).success).toBe(true);
    expect(storeMemoryTool.schema.safeParse({ ...base, type: 'bug_fix' }).success).toBe(false);
  });

  it('las dos se llaman igual: el modelo ve una sola tool', () => {
    expect(storeMemoryTool.name).toBe(storeDecisionTool.name);
    expect(recallMemoryTool.name).toBe(recallDecisionsTool.name);
  });
});

describe('recall_decisions con secciones', () => {
  it('muestra la sección (migrando un tipo antiguo) y el resumen', async () => {
    const { ctx, memory } = setup();
    await memory.save({
      ...base,
      type: 'user_preference',
      importance: 'medium',
      summary: 'Resumen propio',
    });
    const out = await recallMemoryTool.execute({ query: 'hermana' }, ctx);
    expect(out.ok && out.output).toContain('[profile/medium]');
    expect(out.ok && out.output).toContain('Resumen propio');
    // La de código no migra nada.
    const code = await recallDecisionsTool.execute({ query: 'hermana' }, ctx);
    expect(code.ok && code.output).toContain('[user_preference/medium]');
  });
});
