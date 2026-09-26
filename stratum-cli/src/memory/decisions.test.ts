import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { DecisionStore, DecisionStoreError, type DecisionInput } from './decisions.js';

const sampleInput: DecisionInput = {
  title: 'Usar sqlite-vec en lugar de Chroma',
  content: 'Embebido y sin servidor. Chroma requería Docker.',
  type: 'architectural',
  tags: ['database', 'vectors'],
  importance: 'high',
};

describe('DecisionStore', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'stratum-dec-'));
    file = join(dir, 'decisions.json');
  });

  afterEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  it('devuelve [] cuando el archivo no existe', () => {
    expect(new DecisionStore(file).load()).toEqual([]);
  });

  it('genera id con formato dec_YYYYMMDD_<6>', () => {
    const id = DecisionStore.generateId(new Date(Date.UTC(2026, 5, 16)));
    expect(id).toMatch(/^dec_20260616_[0-9a-z]{6}$/);
  });

  it('add crea record con embedding_ref derivado del id y lo persiste', () => {
    const store = new DecisionStore(file);
    const rec = store.add(sampleInput);
    expect(rec.id).toMatch(/^dec_\d{8}_[0-9a-z]{6}$/);
    expect(rec.embedding_ref).toBe(`vec_${rec.id}`);
    expect(rec.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(existsSync(file)).toBe(true);
    expect(new DecisionStore(file).load()).toHaveLength(1);
  });

  it('get / getByRef recuperan la entrada', () => {
    const store = new DecisionStore(file);
    const rec = store.add(sampleInput);
    expect(store.get(rec.id)?.title).toBe(sampleInput.title);
    expect(store.getByRef(rec.embedding_ref)?.id).toBe(rec.id);
    expect(store.get('inexistente')).toBeUndefined();
  });

  it('remove elimina y devuelve true solo si existía', () => {
    const store = new DecisionStore(file);
    const rec = store.add(sampleInput);
    expect(store.remove(rec.id)).toBe(true);
    expect(store.all()).toHaveLength(0);
    expect(store.remove(rec.id)).toBe(false);
  });

  it('tolera un JSON corrupto devolviendo []', () => {
    const store = new DecisionStore(file);
    store.add(sampleInput);
    // Corromper el archivo
    writeFileSync(file, '{ no es json', 'utf-8');
    expect(store.load()).toEqual([]);
  });

  it('un fichero dañado se aparta antes de escribir, nunca se pisa', () => {
    writeFileSync(file, '[{"id": "dec_1", "title": "a medias', 'utf-8');
    const store = new DecisionStore(file);
    const rec = store.add(sampleInput);

    const aside = readdirSync(dir).filter((f) => f.startsWith('decisions.json.corrupt-'));
    expect(aside).toHaveLength(1);
    expect(readFileSync(join(dir, aside[0]!), 'utf-8')).toBe('[{"id": "dec_1", "title": "a medias');
    expect(store.load().map((r) => r.id)).toEqual([rec.id]);
  });

  it('remove sobre un fichero dañado también lo aparta en vez de reescribirlo', () => {
    writeFileSync(file, 'basura', 'utf-8');
    expect(new DecisionStore(file).remove('dec_x')).toBe(false);
    expect(readdirSync(dir).some((f) => f.startsWith('decisions.json.corrupt-'))).toBe(true);
  });

  it('conserva al reescribir las entradas que no valida', () => {
    const foreign = { id: 'dec_future', type: 'tipo_nuevo', title: 't', extra: 1 };
    const store = new DecisionStore(file);
    const rec = store.add(sampleInput);
    const onDisk = JSON.parse(readFileSync(file, 'utf-8')) as unknown[];
    writeFileSync(file, JSON.stringify([...onDisk, foreign]), 'utf-8');

    expect(store.load().map((r) => r.id)).toEqual([rec.id]);
    const rec2 = store.add(sampleInput);
    const after = JSON.parse(readFileSync(file, 'utf-8')) as Array<{ id: string }>;
    expect(after.map((e) => e.id)).toEqual([rec.id, 'dec_future', rec2.id]);
    expect(after[1]).toEqual(foreign);

    expect(store.remove(rec.id)).toBe(true);
    const final = JSON.parse(readFileSync(file, 'utf-8')) as Array<{ id: string }>;
    expect(final.map((e) => e.id)).toEqual(['dec_future', rec2.id]);
  });

  it('un fichero de un Stratum más nuevo no se modifica', () => {
    const newer = JSON.stringify({ schemaVersion: 2, decisions: [] });
    writeFileSync(file, newer, 'utf-8');
    const store = new DecisionStore(file);
    expect(store.load()).toEqual([]);
    expect(() => store.add(sampleInput)).toThrow(DecisionStoreError);
    expect(() => store.remove('dec_x')).toThrow(DecisionStoreError);
    expect(readFileSync(file, 'utf-8')).toBe(newer);
    expect(readdirSync(dir)).toEqual(['decisions.json']);
  });

  it('cada escritura parte de lo que hay en disco: dos instancias no se pisan', () => {
    const a = new DecisionStore(file);
    const b = new DecisionStore(file);
    const r1 = a.add(sampleInput);
    const r2 = b.add(sampleInput);
    expect(a.load().map((r) => r.id)).toEqual([r1.id, r2.id]);
  });

  it('ids consecutivos no colisionan', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 50; i++) ids.add(DecisionStore.generateId());
    expect(ids.size).toBe(50);
  });
});
