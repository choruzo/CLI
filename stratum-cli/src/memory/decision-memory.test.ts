import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'fs';
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
    const { record, deduped, indexed } = await mem.save(sqliteDecision);
    expect(deduped).toBe(false);
    expect(indexed).toBe(true);
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

  it('takeLastRecall devuelve los resultados del último search y luego se limpia', async () => {
    const mem = makeMemory(dir);
    const { record } = await mem.save(sqliteDecision);
    await mem.search('sqlite embeddings');
    const recalled = mem.takeLastRecall();
    expect(recalled.map((r) => r.record.id)).toContain(record.id);
    // Segundo take sin nuevo search → vacío (consumo único)
    expect(mem.takeLastRecall()).toEqual([]);
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
    const { record, indexed } = await mem.save(sqliteDecision);
    expect(indexed).toBe(false);
    expect(mem.store.get(record.id)).toBeDefined();
  });

  it('search auto-reindexa si el índice está vacío pero hay decisiones guardadas', async () => {
    const mem = makeMemory(dir);
    // Simular una decisión guardada SIN indexar (embedder caído en su momento):
    // se inserta directamente en el store, el índice queda vacío.
    mem.store.add(sqliteDecision);
    expect(await mem.vectors.count()).toBe(0);
    // Ahora con embedder operativo, search debe reconstruir el índice y encontrarla.
    const res = await mem.search('sqlite embeddings');
    expect(res.length).toBeGreaterThanOrEqual(1);
    expect(await mem.vectors.count()).toBe(1);
  });

  it('search reindexa las decisiones que faltan en un índice incompleto', async () => {
    const mem = makeMemory(dir);
    const a = await mem.save(sqliteDecision);
    // Guardada sin indexar (embedder caído en su momento): el índice no está
    // vacío, así que la reparación antigua (solo con count() === 0) no actuaba.
    const b = mem.store.add({ ...sqliteDecision, title: 'Modelo onnx', content: 'python onnx' });
    expect(await mem.vectors.count()).toBe(1);

    const res = await mem.search('onnx python');
    expect(res[0]?.record.id).toBe(b.id);
    expect(await mem.vectors.has(a.record.embedding_ref)).toBe(true);
    expect(await mem.vectors.count()).toBe(2);
  });

  it('un sidecar dañado no deja decisiones fuera del recall', async () => {
    const mem = makeMemory(dir);
    await mem.save(sqliteDecision);
    writeFileSync(join(dir, 'vectors.fallback.json'), '{ roto', 'utf-8');
    const fresh = makeMemory(dir);
    await fresh.save({ ...sqliteDecision, title: 'Tabs', content: 'tabs vmware' });
    const res = await fresh.search('sqlite chroma docker');
    expect(res[0]?.record.title).toBe(sqliteDecision.title);
  });

  it('el dedup ve también las decisiones que no estaban indexadas', async () => {
    const mem = makeMemory(dir);
    const existing = mem.store.add(sqliteDecision);
    const { deduped, duplicateOf } = await mem.save(sqliteDecision);
    expect(deduped).toBe(true);
    expect(duplicateOf).toBe(existing.id);
    expect(mem.list()).toHaveLength(1);
  });
});
