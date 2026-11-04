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
import { storeDecisionTool } from './store-decision.js';

const dirs: string[] = [];
const memories: DecisionMemory[] = [];
afterEach(async () => {
  for (const m of memories.splice(0)) await m.vectors.close();
  _resetDecisionMemoryCache();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'store-decision-'));
  dirs.push(dir);
  const config = StratumConfigSchema.parse({
    memory: {
      decisionsFile: join(dir, 'decisions.json'),
      vectorDb: join(dir, 'vectors.db'),
    },
  });
  // Un vector distinto por texto: sin dedup entre decisiones distintas.
  let n = 0;
  const memory = new DecisionMemory(config, {
    embedding: {
      embedFn: async (texts) =>
        texts.map(() => {
          const v = new Float32Array(8);
          v[n++ % 8] = 1;
          return v;
        }),
    },
    forceFallbackVectors: true,
  });
  _setDecisionMemory(config, memory);
  memories.push(memory);
  return { config, memory };
}

const input = {
  title: 'Color favorito: teal',
  content: 'El usuario prefiere el teal.',
  type: 'user_preference',
  tags: ['color'],
  importance: 'medium',
};

describe('store_decision — procedencia (M17)', () => {
  it('guarda la sesión en la que se guardó, con source agent', async () => {
    const { config, memory } = setup();
    const ctx = { config, sessionId: 'ses_abc' } as unknown as ToolContext;
    const result = await storeDecisionTool.execute(input, ctx);
    expect(result.ok).toBe(true);
    expect(memory.list()).toEqual([
      expect.objectContaining({ title: input.title, source: 'agent', session_id: 'ses_abc' }),
    ]);
  });

  it('sin sesión no inventa una', async () => {
    const { config, memory } = setup();
    await storeDecisionTool.execute(input, { config } as unknown as ToolContext);
    const [record] = memory.list();
    expect(record).toMatchObject({ source: 'agent' });
    expect(record).not.toHaveProperty('session_id');
  });
});
