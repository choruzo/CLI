import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { StratumConfigSchema } from '../config/schema.js';
import { DecisionMemory, ignoreDerivedIndex, type DecisionMemoryEvent } from './decision-memory.js';
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

  it('subscribe: avisa de cada guardado y borrado, con su origen', async () => {
    const mem = makeMemory(dir);
    const events: DecisionMemoryEvent[] = [];
    const stop = mem.subscribe((ev) => events.push(ev));

    const first = await mem.save({ ...sqliteDecision, source: 'agent', session_id: 's1' });
    // Near-duplicado: no escribe, pero el intento se ve.
    await mem.save({ ...sqliteDecision, title: 'Elegir sqlite-vec sobre Chroma', source: 'auto' });
    await mem.remove(first.record.id);
    await mem.remove('dec_00000000_nohay');

    expect(events).toEqual([
      { type: 'saved', record: first.record, deduped: false, indexed: true },
      { type: 'saved', record: first.record, deduped: true, indexed: true },
      { type: 'removed', id: first.record.id },
    ]);
    expect(first.record.source).toBe('agent');
    expect(first.record.session_id).toBe('s1');

    stop();
    await mem.save({ ...sqliteDecision, title: 'Docker para vmware', content: 'docker vmware' });
    expect(events).toHaveLength(3);
  });

  it('subscribe: un listener que lanza no hace fallar la escritura', async () => {
    const mem = makeMemory(dir);
    mem.subscribe(() => {
      throw new Error('listener roto');
    });
    const seen: string[] = [];
    mem.subscribe((ev) => seen.push(ev.type));

    const result = await mem.save(sqliteDecision);

    expect(result.deduped).toBe(false);
    expect(mem.list()).toHaveLength(1);
    expect(seen).toEqual(['saved']);
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

describe('ignoreDerivedIndex', () => {
  let base: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'stratum-ign-'));
  });
  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  function memoryDir(repo: string, git: boolean): string {
    if (git) mkdirSync(join(repo, '.git'), { recursive: true });
    const dir = join(repo, '.stratum', 'memory');
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  it('escribe el .gitignore en <repo>/.stratum/memory/', () => {
    const dir = memoryDir(join(base, 'repo'), true);
    ignoreDerivedIndex(join(dir, 'vectors.db'));
    const text = readFileSync(join(dir, '.gitignore'), 'utf-8');
    expect(text).toContain('vectors.db*');
    expect(text).toContain('*.fallback.json');
  });

  it('no lo escribe fuera de un repo git', () => {
    const dir = memoryDir(join(base, 'plain'), false);
    ignoreDerivedIndex(join(dir, 'vectors.db'));
    expect(existsSync(join(dir, '.gitignore'))).toBe(false);
  });

  it('no lo escribe si el directorio no es .stratum/memory', () => {
    const repo = join(base, 'repo');
    mkdirSync(join(repo, '.git'), { recursive: true });
    const other = join(repo, 'custom');
    mkdirSync(other, { recursive: true });
    ignoreDerivedIndex(join(other, 'vectors.db'));
    expect(existsSync(join(other, '.gitignore'))).toBe(false);
    const wrongParent = join(repo, 'data', 'memory');
    mkdirSync(wrongParent, { recursive: true });
    ignoreDerivedIndex(join(wrongParent, 'vectors.db'));
    expect(existsSync(join(wrongParent, '.gitignore'))).toBe(false);
  });

  it('no pisa un .gitignore existente', () => {
    const dir = memoryDir(join(base, 'repo'), true);
    writeFileSync(join(dir, '.gitignore'), 'mio\n', 'utf-8');
    ignoreDerivedIndex(join(dir, 'vectors.db'));
    expect(readFileSync(join(dir, '.gitignore'), 'utf-8')).toBe('mio\n');
  });

  it('DecisionMemory lo deja al indexar (save)', async () => {
    const dir = memoryDir(join(base, 'repo'), true);
    const config = StratumConfigSchema.parse({
      memory: {
        decisionsFile: join(dir, 'decisions.json'),
        vectorDb: join(dir, 'vectors.db'),
        embeddingDimension: VOCAB.length,
      },
    });
    const mem = new DecisionMemory(config, {
      embedding: { embedFn: fakeEmbed },
      forceFallbackVectors: true,
    });
    await mem.save(sqliteDecision);
    expect(existsSync(join(dir, '.gitignore'))).toBe(true);
  });
});
