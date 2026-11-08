/**
 * M19 fase 1 — taxonomía por secciones en las memorias de `assistant` y
 * `companion`: tipos que se migran al leer, `summary`, `updatedAt`,
 * reclasificar y la extracción automática con secciones.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { StratumConfigSchema } from '../config/schema.js';
import { PROTOCOL_MEMORY_SECTIONS } from '../protocol/model.js';
import { DecisionMemory } from './decision-memory.js';
import {
  DecisionStore,
  MEMORY_SECTIONS,
  presentedType,
  summaryOf,
  type DecisionInput,
} from './decisions.js';
import { EXTRACT_SECTIONS_PROMPT, EXTRACT_SYSTEM_PROMPT, extractAndStore } from './extractor.js';
import type { IProvider, OpenAIStreamChunk } from '../providers/base.js';
import type { Message } from '../agent/types.js';

const input: DecisionInput = {
  title: 'Prefiere respuestas cortas',
  content: 'Le gustan las respuestas en tres líneas como máximo.\nY sin emojis.',
  type: 'profile',
  tags: ['estilo'],
  importance: 'medium',
};

describe('presentedType (B2, B3)', () => {
  it('en secciones, los 6 tipos antiguos pasan a topic, salvo user_preference → profile', () => {
    for (const old of ['architectural', 'tooling', 'convention', 'bug_fix', 'security']) {
      expect(presentedType(old, 'sections')).toBe('topic');
    }
    expect(presentedType('user_preference', 'sections')).toBe('profile');
  });

  it('una sección se queda como está, y un tipo desconocido es topic', () => {
    for (const s of MEMORY_SECTIONS) expect(presentedType(s, 'sections')).toBe(s);
    expect(presentedType('algo-nuevo', 'sections')).toBe('topic');
  });

  it('en código no cambia nada', () => {
    expect(presentedType('user_preference', 'code')).toBe('user_preference');
    expect(presentedType('bug_fix', 'code')).toBe('bug_fix');
  });

  it('el protocolo repite las mismas secciones que la memoria', () => {
    expect([...PROTOCOL_MEMORY_SECTIONS]).toEqual([...MEMORY_SECTIONS]);
  });
});

describe('summaryOf', () => {
  it('usa el resumen guardado; sin él, la primera línea del contenido', () => {
    expect(summaryOf({ summary: ' Respuestas cortas ', content: 'x' })).toBe('Respuestas cortas');
    expect(summaryOf({ content: 'Primera línea\nSegunda' })).toBe('Primera línea');
  });

  it('recorta una primera línea larga', () => {
    const out = summaryOf({ content: 'a'.repeat(300) });
    expect(out).toHaveLength(140);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('DecisionStore — summary, updatedAt y update', () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'stratum-sec-'));
    file = join(dir, 'decisions.json');
  });
  afterEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  it('add guarda summary y sella updatedAt; sin summary no escribe el campo', () => {
    const store = new DecisionStore(file);
    const now = new Date('2026-11-08T10:00:00Z');
    const a = store.add({ ...input, summary: '  Respuestas cortas  ' }, now);
    expect(a).toMatchObject({ summary: 'Respuestas cortas', updatedAt: now.toISOString() });
    const b = store.add(input, now);
    expect(b).not.toHaveProperty('summary');
    expect(store.load()).toHaveLength(2);
  });

  it('update reclasifica, sella updatedAt y conserva lo que esta versión no conoce', () => {
    const store = new DecisionStore(file);
    const rec = store.add(input, new Date('2026-11-08T10:00:00Z'));
    // Una versión más nueva añadió un campo: no debe perderse al reclasificar.
    const raw = JSON.parse(readFileSync(file, 'utf-8')) as Array<Record<string, unknown>>;
    raw[0]!.futuro = { x: 1 };
    writeFileSync(file, JSON.stringify(raw));

    const later = new Date('2026-11-09T09:00:00Z');
    const updated = store.update(rec.id, { type: 'person' }, later);
    expect(updated).toMatchObject({ id: rec.id, type: 'person', updatedAt: later.toISOString() });
    const onDisk = JSON.parse(readFileSync(file, 'utf-8')) as Array<Record<string, unknown>>;
    expect(onDisk[0]).toMatchObject({ type: 'person', futuro: { x: 1 } });
    expect(onDisk[0]!.timestamp).toBe(rec.timestamp);
  });

  it('update de un id que no está devuelve undefined y no escribe', () => {
    const store = new DecisionStore(file);
    store.add(input);
    const before = readFileSync(file, 'utf-8');
    expect(store.update('dec_nope', { type: 'area' })).toBeUndefined();
    expect(readFileSync(file, 'utf-8')).toBe(before);
  });

  it('un fichero con las decisiones antiguas (sin summary ni updatedAt) se sigue leyendo', () => {
    writeFileSync(
      file,
      JSON.stringify([
        {
          id: 'dec_20260101_aaaaaa',
          timestamp: '2026-01-01T00:00:00Z',
          type: 'user_preference',
          title: 'Antigua',
          content: 'c',
          tags: [],
          importance: 'low',
          embedding_ref: 'vec_dec_20260101_aaaaaa',
        },
      ]),
    );
    const [rec] = new DecisionStore(file).load();
    expect(rec).toMatchObject({ title: 'Antigua', type: 'user_preference' });
    expect(rec).not.toHaveProperty('updatedAt');
  });
});

function memoryAt(dir: string): DecisionMemory {
  const config = StratumConfigSchema.parse({
    memory: {
      decisionsFile: join(dir, 'decisions.json'),
      vectorDb: join(dir, 'vectors.db'),
      embeddingDimension: 4,
    },
  });
  // Un vector distinto por texto: sin dedup entre recuerdos distintos.
  let n = 0;
  return new DecisionMemory(config, {
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
}

describe('DecisionMemory.reclassify', () => {
  it('cambia la sección sin tocar el índice', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stratum-sec-mem-'));
    const memory = memoryAt(dir);
    try {
      const { record } = await memory.save({ ...input, type: 'topic' });
      const updated = await memory.reclassify(record.id, { type: 'person' });
      expect(updated?.type).toBe('person');
      expect(memory.list()[0]?.type).toBe('person');
      expect(await memory.reclassify('dec_nope', { type: 'area' })).toBeUndefined();
    } finally {
      await memory.vectors.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('extractAndStore con secciones', () => {
  const convo: Message[] = [
    { role: 'user', content: 'Mi hermana Lucía cumple años el 3 de marzo.' },
    { role: 'assistant', content: 'Lo apunto.' },
  ];
  const provider = (reply: string, seen: Message[][]): IProvider => ({
    async *complete(req: { messages: Message[] }): AsyncGenerator<OpenAIStreamChunk> {
      seen.push(req.messages);
      yield { choices: [{ delta: { content: reply }, finish_reason: null, index: 0 }] };
    },
    async healthCheck() {
      return true;
    },
  });

  it('usa el prompt de secciones y guarda tipo y resumen; un tipo dudoso es topic', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stratum-sec-ex-'));
    const seen: Message[][] = [];
    const m = memoryAt(dir);
    try {
      const reply = JSON.stringify([
        {
          title: 'Cumpleaños de Lucía',
          content: 'Su hermana Lucía cumple años el 3 de marzo.',
          summary: 'Lucía (hermana): cumple el 3 de marzo',
          type: 'person',
          tags: ['familia'],
          importance: 'medium',
        },
        {
          title: 'Otra cosa',
          content: 'Algo sin clasificar claro.',
          type: 'tooling',
          tags: [],
          importance: 'low',
        },
      ]);
      const added = await extractAndStore({
        provider: provider(reply, seen),
        model: 'm',
        messages: convo,
        memory: m,
        taxonomy: 'sections',
      });
      expect(added).toBe(2);
      expect(seen[0]![0]!.content).toBe(EXTRACT_SECTIONS_PROMPT);
      const byTitle = Object.fromEntries(m.list().map((d) => [d.title, d]));
      expect(byTitle['Cumpleaños de Lucía']).toMatchObject({
        type: 'person',
        summary: 'Lucía (hermana): cumple el 3 de marzo',
      });
      expect(byTitle['Otra cosa']).toMatchObject({ type: 'topic' });
      expect(byTitle['Otra cosa']).not.toHaveProperty('summary');
    } finally {
      await m.vectors.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('sin taxonomía sigue usando el prompt de código y los 6 tipos', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stratum-sec-ex-'));
    const seen: Message[][] = [];
    const m = memoryAt(dir);
    try {
      const reply = JSON.stringify([
        {
          title: 'Usar Ansible',
          content: 'Se decidió Ansible.',
          type: 'person',
          tags: [],
          importance: 'low',
        },
      ]);
      await extractAndStore({
        provider: provider(reply, seen),
        model: 'm',
        messages: convo,
        memory: m,
      });
      expect(seen[0]![0]!.content).toBe(EXTRACT_SYSTEM_PROMPT);
      // `person` no es un tipo de código: cae al de siempre.
      expect(m.list()[0]?.type).toBe('convention');
    } finally {
      await m.vectors.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
