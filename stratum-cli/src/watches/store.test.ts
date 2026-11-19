/**
 * M22 — el almacén de vigilantes: escritura atómica, validación al leer, un
 * fichero de un Stratum más nuevo o dañado se queda en solo lectura (sin
 * reescribirse nunca), y el estado de cada vigilante solo se escribe si cambia.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { MemorySink, resetLogging } from '../logging/index.js';
import { WATCH_LIMITS } from '../protocol/index.js';
import type { WatchDefinition } from './define.js';
import { INITIAL_WATCH_STATE, type WatchState } from './engine.js';
import {
  WATCHES_SCHEMA_VERSION,
  WatchStore,
  WatchStoreError,
  watchesFile,
  type StoredWatch,
} from './store.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const T0 = Date.UTC(2026, 10, 17, 9, 0, 0);

function tempStore(opts: { newId?: () => string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'stratum-watches-'));
  dirs.push(dir);
  const file = watchesFile(dir);
  return { dir, file, store: new WatchStore(file, opts) };
}

const def = (over: Partial<WatchDefinition> = {}): WatchDefinition => ({
  name: 'Salón',
  connector: 'home-assistant',
  check: 'ha_comprobar',
  args: { entity_id: 'light.salon' },
  condition: { kind: 'state-is', values: ['off'] },
  intervalSec: 60,
  cooldownMinutes: 30,
  notifyResolved: false,
  origin: 'person',
  ...over,
});

interface StoredFile {
  schemaVersion?: unknown;
  watches: StoredWatch[];
  [key: string]: unknown;
}

function stored(file: string): StoredFile {
  return JSON.parse(readFileSync(file, 'utf-8')) as StoredFile;
}

const errorCode = (fn: () => unknown): string => {
  try {
    fn();
  } catch (err) {
    return err instanceof WatchStoreError ? err.code : `threw ${String(err)}`;
  }
  return 'OK';
};

describe('M22 — WatchStore', () => {
  it('sin fichero: vacío y escribible, y escribe con schemaVersion y estado inicial', () => {
    const { file, store } = tempStore();
    store.load();
    expect(store.readOnly).toBe(false);
    expect(store.loadProblem).toBeNull();
    expect(store.list()).toEqual([]);

    const watch = store.add(def(), T0);
    expect(watch.id).toMatch(/^wat_[0-9a-z]{10}$/);
    expect(watch).toMatchObject({
      name: 'Salón',
      status: 'active',
      createdAt: T0,
      state: INITIAL_WATCH_STATE,
    });
    const onDisk = stored(file);
    expect(onDisk.schemaVersion).toBe(WATCHES_SCHEMA_VERSION);
    expect(onDisk.watches).toHaveLength(1);
  });

  it(`no pasa de ${WATCH_LIMITS.watches} vigilantes`, () => {
    const { store } = tempStore();
    store.load();
    for (let i = 0; i < WATCH_LIMITS.watches; i++) store.add(def({ name: `v${i}` }), T0);
    expect(errorCode(() => store.add(def({ name: 'uno más' }), T0))).toBe('invalid');
    // Con uno borrado vuelve a haber sitio.
    store.remove(store.list()[0]!.id);
    expect(store.add(def({ name: 'uno más' }), T0).name).toBe('uno más');
  });

  it('list los da por fecha de creación, y get devuelve copias', () => {
    const { store } = tempStore();
    store.load();
    const b = store.add(def({ name: 'b' }), T0 + 1);
    const a = store.add(def({ name: 'a' }), T0);
    expect(store.list().map((w) => w.name)).toEqual(['a', 'b']);
    const got = store.get(a.id)!;
    got.name = 'tocado';
    expect(store.get(a.id)!.name).toBe('a');
    expect(store.get('wat_nope')).toBeUndefined();
    expect(store.get(b.id)!.name).toBe('b');
  });

  it('un id repetido no se repite', () => {
    let n = 0;
    const { store } = tempStore({ newId: () => `wat_fijo${n++}` });
    store.load();
    expect(store.add(def(), T0).id).toBe('wat_fijo0');
    expect(store.add(def(), T0).id).toBe('wat_fijo1');
  });

  it('setStatus pausa y reanuda, reiniciando la cuenta y los avisos pero no el flanco', () => {
    const { store } = tempStore();
    store.load();
    const { id } = store.add(def(), T0);
    const firing: WatchState = {
      firing: true,
      pendingSince: T0,
      reference: 'off',
      lastFiredAt: T0,
      failures: 2,
      failingNotified: true,
      suspendedNotified: true,
    };
    expect(store.saveState(id, firing)).toBe(true);
    expect(store.get(id)!.state).toEqual(firing);

    const paused = store.setStatus(id, 'paused');
    expect(paused).toMatchObject({ status: 'paused' });
    expect(paused.state).toEqual({
      ...firing,
      pendingSince: null,
      failures: 0,
      failingNotified: false,
      suspendedNotified: false,
    });
    expect(store.list()[0]).toMatchObject({ status: 'paused', state: { firing: true } });

    expect(store.setStatus(id, 'active').status).toBe('active');
    expect(errorCode(() => store.setStatus('wat_nope', 'paused'))).toBe('not-found');
  });

  it('remove lo quita del fichero y dice cuál era; uno desconocido, not-found', () => {
    const { file, store } = tempStore();
    store.load();
    const { id } = store.add(def({ name: 'fuera' }), T0);
    expect(store.remove(id).name).toBe('fuera');
    expect(store.list()).toEqual([]);
    expect(stored(file).watches).toEqual([]);
    expect(errorCode(() => store.remove(id))).toBe('not-found');
  });

  it('saveState escribe solo si cambia, y nunca reescribe uno borrado', () => {
    const { file, store } = tempStore();
    store.load();
    const { id } = store.add(def(), T0);
    const before = readFileSync(file, 'utf-8');
    // Mismo estado: ni escribe ni devuelve `true`. El campo de más lo prueba:
    // si hubiera reescrito, estaría en el fichero.
    const same = { ...INITIAL_WATCH_STATE, futuro: true } as unknown as WatchState;
    expect(store.saveState(id, same)).toBe(false);
    expect(readFileSync(file, 'utf-8')).toBe(before);

    // Un estado distinto sí se escribe, y solo ese campo cambia.
    expect(store.saveState(id, { ...INITIAL_WATCH_STATE, firing: true })).toBe(true);
    expect(stored(file).watches[0]!.state).toMatchObject({ firing: true, failures: 0 });
    expect('futuro' in stored(file).watches[0]!.state).toBe(false);

    store.remove(id);
    const afterRemove = readFileSync(file, 'utf-8');
    expect(store.saveState(id, { ...INITIAL_WATCH_STATE, firing: false })).toBe(false);
    expect(readFileSync(file, 'utf-8')).toBe(afterRemove);
  });

  it('conserva campos desconocidos de una versión compatible al reescribir', () => {
    const { file, store } = tempStore();
    writeFileSync(
      file,
      JSON.stringify({
        schemaVersion: WATCHES_SCHEMA_VERSION,
        future: { x: 1 },
        watches: [
          {
            ...def(),
            id: 'wat_1',
            status: 'active',
            createdAt: T0,
            state: INITIAL_WATCH_STATE,
            colour: 'verde',
          },
        ],
      }),
      'utf-8',
    );
    store.load();
    expect(store.readOnly).toBe(false);
    store.add(def({ name: 'otro' }), T0);
    const onDisk = stored(file);
    expect(onDisk.future).toEqual({ x: 1 });
    expect(onDisk.watches[0]).toMatchObject({ colour: 'verde', id: 'wat_1' });
  });

  it('un fichero dañado no lleva el nombre de un vigilante al log', () => {
    const sink = new MemorySink('trace');
    resetLogging([sink], true);
    try {
      const { file, store } = tempStore();
      writeFileSync(file, '{"watches": [{"name": "Salón SECRETO-XYZ"', 'utf-8');
      store.load();
      expect(store.readOnly).toBe(true);
      const logged = JSON.stringify(sink.records);
      expect(logged).toContain('watches file is unreadable');
      expect(logged).not.toContain('SECRETO-XYZ');
      expect(logged).toContain('SyntaxError');
    } finally {
      resetLogging();
    }
  });

  it.each([
    ['de una versión más nueva', JSON.stringify({ schemaVersion: 2, watches: [] }), 'newer'],
    [
      'con un schemaVersion inválido',
      JSON.stringify({ schemaVersion: 'x', watches: [] }),
      'invalid',
    ],
    ['ilegible', '{ no es json', 'unreadable'],
    [
      'que no valida',
      JSON.stringify({ schemaVersion: 1, watches: [{ id: 'wat_1', name: 'a' }] }),
      'invalid',
    ],
    [
      'con un intervalo por debajo del mínimo',
      JSON.stringify({
        schemaVersion: 1,
        watches: [
          {
            ...def(),
            id: 'wat_1',
            status: 'active',
            createdAt: T0,
            intervalSec: 30,
            state: INITIAL_WATCH_STATE,
          },
        ],
      }),
      'invalid',
    ],
  ])('un fichero %s deja el almacén en solo lectura y no se toca', (_label, content, problem) => {
    const { file, store } = tempStore();
    writeFileSync(file, content, 'utf-8');
    store.load();
    expect(store.readOnly).toBe(true);
    expect(store.loadProblem).toBe(problem);
    expect(store.list()).toEqual([]);
    expect(errorCode(() => store.add(def(), T0))).toBe('read-only');
    expect(errorCode(() => store.setStatus('wat_1', 'paused'))).toBe('read-only');
    expect(errorCode(() => store.remove('wat_1'))).toBe('read-only');
    expect(errorCode(() => store.saveState('wat_1', INITIAL_WATCH_STATE))).toBe('read-only');
    // Ni una escritura: el fichero sigue byte a byte igual.
    expect(readFileSync(file, 'utf-8')).toBe(content);
  });
});
