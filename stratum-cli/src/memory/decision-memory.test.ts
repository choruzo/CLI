import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { StratumConfigSchema } from '../config/schema.js';
import { DecisionMemory } from './decision-memory.js';
import type { EmbedFn } from './embeddings.js';
import type { DecisionInput } from './decisions.js';

// Embedder determinista basado en un vocabulario fijo: textos que comparten
// palabras clave obtienen vectores parecidos (coseno alto).
const VOCAB = ['sqlite', 'chroma', 'docker', 'python', 'vmware', 'embeddings', 'onnx', 'tabs'];
const fakeEmbed: EmbedFn = async (texts) =>
  texts.map((t) => {
    const lc = t.toLowerCase();
    const vec = new Float32Array(VOCAB.length);
    VOCAB.forEach((w, i) => {
      if (lc.includes(w)) vec[i] = 1;
    });
    if (vec.every((x) => x === 0)) vec[0] = 0.001;
    return vec;
  });

function makeMemory(dir: string): DecisionMemory {
  const config = StratumConfigSchema.parse({
    memory: {
      decisionsFile: join(dir, 'decisions.json'),
      vectorDb: join(dir, 'vectors.db'),
      embeddingDimension: VOCAB.length,
      similarityThreshold: 0.9,
    },
  });
  return new DecisionMemory(config, {
    embedding: { embedFn: fakeEmbed },
    forceFallbackVectors: true,
  });
}

const sqliteDecision: DecisionInput = {
  title: 'Usar sqlite-vec en vez de Chroma',
  content: 'sqlite embebido, sin docker.',
  type: 'architectural',
  tags: ['sqlite'],
  importance: 'high',
};

describe('DecisionMemory', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'stratum-dm-'));
  });
  afterEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  it('save persiste y luego search recupera la decisión', async () => {
    const mem = makeMemory(dir);
    const { record, deduped } = await mem.save(sqliteDecision);
    expect(deduped).toBe(false);
    expect(record.source).toBe(undefined);

    const results = await mem.search('por qué elegimos sqlite embeddings');
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]!.record.id).toBe(record.id);
  });

  it('dedup: una decisión casi idéntica no crea entrada nueva', async () => {
    const mem = makeMemory(dir);
    const first = await mem.save(sqliteDecision);
    const second = await mem.save({
      ...sqliteDecision,
      title: 'Elegir sqlite-vec sobre Chroma',
      content: 'sqlite embebido sin docker',
    });
    expect(second.deduped).toBe(true);
    expect(second.duplicateOf).toBe(first.record.id);
    expect(mem.list()).toHaveLength(1);
  });

  it('decisiones distintas conviven', async () => {
    const mem = makeMemory(dir);
    await mem.save(sqliteDecision);
    await mem.save({
      title: 'Convención de tabs',
      content: 'usar tabs no python spaces',
      type: 'convention',
      tags: ['tabs'],
      importance: 'medium',
    });
    expect(mem.list()).toHaveLength(2);
  });

  it('remove elimina del store y del índice', async () => {
    const mem = makeMemory(dir);
    const { record } = await mem.save(sqliteDecision);
    expect(await mem.remove(record.id)).toBe(true);
    expect(mem.list()).toHaveLength(0);
    expect(await mem.search('sqlite')).toHaveLength(0);
  });

  it('degrada sin embedder: persiste pero no indexa semánticamente', async () => {
    const config = StratumConfigSchema.parse({
      memory: { decisionsFile: join(dir, 'd.json'), vectorDb: join(dir, 'v.db') },
    });
    // embedFn que devuelve "sin backend" → simulamos null devolviendo vacío.
    const mem = new DecisionMemory(config, {
      embedding: { embedFn: async () => [] },
      forceFallbackVectors: true,
    });
    const { record } = await mem.save(sqliteDecision);
    expect(mem.store.get(record.id)).toBeDefined();
  });
});
