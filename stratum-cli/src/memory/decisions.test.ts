import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { DecisionStore, type DecisionInput } from './decisions.js';

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

  it('ids consecutivos no colisionan', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 50; i++) ids.add(DecisionStore.generateId());
    expect(ids.size).toBe(50);
  });
});
