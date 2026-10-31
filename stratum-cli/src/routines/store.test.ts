import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RoutineStore, RoutineStoreError, routinesFile, ROUTINES_FILE } from './store.js';

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stratum-routines-'));
  file = join(dir, ROUTINES_FILE);
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function mk(f = file, now = new Date('2026-10-31T10:00:00.000Z')): RoutineStore {
  const s = new RoutineStore(f, { now: () => now });
  s.load();
  return s;
}

const base = { name: 'Daily', schedule: '1d', prompt: 'Resume mi día' };

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return e instanceof RoutineStoreError ? e.code : `other:${String(e)}`;
  }
  return undefined;
}

describe('RoutineStore', () => {
  it('routinesFile une el directorio y el nombre', () => {
    expect(routinesFile('/x')).toBe(join('/x', ROUTINES_FILE));
  });

  it('sin fichero: vacío y escribible; no crea nada al cargar', () => {
    const s = mk();
    expect(s.list()).toEqual([]);
    expect(s.readOnly).toBe(false);
    expect(s.loadProblem).toBeNull();
    expect(existsSync(file)).toBe(false);
  });

  it('add/get/list/update/remove persisten y se releen con otra instancia', () => {
    const s = mk();
    const r = s.add({
      ...base,
      model: '  glm  ',
      limits: { maxIterations: 10, timeoutMinutes: 5 },
    });
    expect(r.id).toMatch(/^rt_[0-9a-z]{10}$/);
    expect(r).toMatchObject({
      name: 'Daily',
      schedule: '1d',
      prompt: 'Resume mi día',
      model: 'glm',
      enabled: true,
      createdAt: '2026-10-31T10:00:00.000Z',
      limits: { maxIterations: 10, timeoutMinutes: 5 },
    });
    const second = s.add({ name: 'Weekly', schedule: '0 9 * * 1', prompt: 'p', enabled: false });
    expect(second.enabled).toBe(false);

    const again = mk();
    expect(again.list().map((x) => x.id)).toEqual([r.id, second.id]);
    expect(again.get(r.id)).toEqual(r);

    const upd = again.update(r.id, {
      name: ' Diaria ',
      enabled: false,
      model: '',
      limits: undefined,
    });
    expect(upd).toMatchObject({ name: 'Diaria', enabled: false, id: r.id, createdAt: r.createdAt });
    expect(upd.model).toBeUndefined();
    expect(upd.limits).toBeUndefined();

    const third = mk();
    expect(third.get(r.id)).toEqual(upd);
    expect(third.remove(r.id).id).toBe(r.id);
    expect(
      mk()
        .list()
        .map((x) => x.id),
    ).toEqual([second.id]);
  });

  it('list/get devuelven copias', () => {
    const s = mk();
    const r = s.add({ ...base, limits: { maxIterations: 3 } });
    const copy = s.list()[0];
    copy.name = 'otro';
    copy.limits!.maxIterations = 99;
    expect(s.get(r.id)).toEqual(r);
  });

  it('crea el directorio padre si falta', () => {
    const nested = join(dir, 'a', 'b', ROUTINES_FILE);
    const s = mk(nested);
    s.add(base);
    expect(existsSync(nested)).toBe(true);
  });

  it('update no cambia id ni createdAt', () => {
    const s = mk();
    const r = s.add(base);
    const upd = s.update(r.id, { id: 'rt_x', createdAt: '2000-01-01T00:00:00.000Z' } as never);
    expect(upd.id).toBe(r.id);
    expect(upd.createdAt).toBe(r.createdAt);
  });

  it('validaciones: el error nombra el campo', () => {
    const s = mk();
    const cases: [Parameters<RoutineStore['add']>[0], RegExp][] = [
      [{ ...base, name: '   ' }, /name/],
      [{ ...base, name: 'x'.repeat(81) }, /name/],
      [{ ...base, prompt: ' ' }, /prompt/],
      [{ ...base, prompt: 'x'.repeat(8001) }, /prompt/],
      [{ ...base, schedule: '59s' }, /schedule/],
      [{ ...base, limits: { maxIterations: 0 } }, /limits\.maxIterations/],
      [{ ...base, limits: { maxIterations: 201 } }, /limits\.maxIterations/],
      [{ ...base, limits: { timeoutMinutes: 1441 } }, /limits\.timeoutMinutes/],
      [{ ...base, limits: { timeoutMinutes: 1.5 } }, /limits\.timeoutMinutes/],
    ];
    for (const [input, re] of cases) {
      try {
        s.add(input);
        throw new Error('debía fallar');
      } catch (e) {
        expect(e).toBeInstanceOf(RoutineStoreError);
        expect((e as RoutineStoreError).code).toBe('invalid');
        expect((e as RoutineStoreError).message).toMatch(re);
      }
    }
    expect(s.list()).toEqual([]);
    expect(existsSync(file)).toBe(false);
  });

  it('update valida el parche y no escribe si falla', () => {
    const s = mk();
    const r = s.add(base);
    expect(codeOf(() => s.update(r.id, { schedule: 'nope' }))).toBe('invalid');
    expect(s.get(r.id)).toEqual(r);
  });

  it('nombre duplicado sin distinguir mayúsculas ni espacios', () => {
    const s = mk();
    s.add(base);
    expect(codeOf(() => s.add({ ...base, name: '  DAILY ' }))).toBe('duplicate-name');
    const other = s.add({ ...base, name: 'Otra' });
    expect(codeOf(() => s.update(other.id, { name: 'daily' }))).toBe('duplicate-name');
    // Renombrar a su propio nombre (con otra capitalización) es válido.
    expect(s.update(other.id, { name: 'OTRA' }).name).toBe('OTRA');
  });

  it('id inexistente: not-found', () => {
    const s = mk();
    expect(codeOf(() => s.update('rt_nope', { enabled: false }))).toBe('not-found');
    expect(codeOf(() => s.remove('rt_nope'))).toBe('not-found');
    expect(s.get('rt_nope')).toBeUndefined();
  });

  it('fichero de una versión más nueva: solo lectura, intacto byte a byte', () => {
    const content = JSON.stringify({ schemaVersion: 2, routines: [{ cosa: 'nueva' }] }, null, 4);
    writeFileSync(file, content);
    const s = mk();
    expect(s.readOnly).toBe(true);
    expect(s.loadProblem).toBe('newer');
    expect(codeOf(() => s.add(base))).toBe('read-only');
    expect(codeOf(() => s.update('x', { enabled: true }))).toBe('read-only');
    expect(codeOf(() => s.remove('x'))).toBe('read-only');
    expect(readFileSync(file, 'utf-8')).toBe(content);
  });

  it('JSON roto: solo lectura e intacto', () => {
    const content = '{ "schemaVersion": 1, "routines": [';
    writeFileSync(file, content);
    const s = mk();
    expect(s.readOnly).toBe(true);
    expect(s.loadProblem).toBe('unreadable');
    expect(s.list()).toEqual([]);
    expect(codeOf(() => s.add(base))).toBe('read-only');
    expect(readFileSync(file, 'utf-8')).toBe(content);
  });

  it('JSON que no valida: solo lectura e intacto', () => {
    const content = JSON.stringify({ schemaVersion: 1, routines: [{ id: 5 }] });
    writeFileSync(file, content);
    const s = mk();
    expect(s.readOnly).toBe(true);
    expect(s.loadProblem).toBe('invalid');
    expect(codeOf(() => s.add(base))).toBe('read-only');
    expect(readFileSync(file, 'utf-8')).toBe(content);
  });

  it('un campo desconocido (en la raíz y en una rutina) sobrevive a un update de otra', () => {
    writeFileSync(
      file,
      JSON.stringify({
        schemaVersion: 1,
        extraRoot: { a: 1 },
        routines: [
          {
            id: 'rt_aaaaaaaaaa',
            name: 'A',
            schedule: '1h',
            prompt: 'p',
            enabled: true,
            createdAt: '2026-01-01T00:00:00.000Z',
            futuro: 'conservar',
          },
          {
            id: 'rt_bbbbbbbbbb',
            name: 'B',
            schedule: '1h',
            prompt: 'p',
            enabled: true,
            createdAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      }),
    );
    const s = mk();
    expect(s.readOnly).toBe(false);
    s.update('rt_bbbbbbbbbb', { enabled: false });
    s.update('rt_aaaaaaaaaa', { name: 'A2' });
    const disk = JSON.parse(readFileSync(file, 'utf-8'));
    expect(disk.schemaVersion).toBe(1);
    expect(disk.extraRoot).toEqual({ a: 1 });
    expect(disk.routines[0]).toMatchObject({ name: 'A2', futuro: 'conservar' });
    expect(disk.routines[1].enabled).toBe(false);
  });
});
