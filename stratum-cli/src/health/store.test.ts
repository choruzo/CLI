import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HealthStore, healthFile } from './store.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stratum-health-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('HealthStore', () => {
  it('sin fichero empieza vacío y guarda lo avisado', () => {
    const file = healthFile(dir);
    const store = new HealthStore(file);
    store.load();
    expect(store.causes()).toEqual([]);
    expect(store.add('connector:google:auth', 1000)).toBe(true);
    expect(store.add('connector:google:auth', 2000)).toBe(false);
    const again = new HealthStore(file);
    again.load();
    expect(again.has('connector:google:auth')).toBe(true);
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    expect(raw).toEqual({
      schemaVersion: 1,
      notified: [{ cause: 'connector:google:auth', at: 1000 }],
    });
  });

  it('olvidar una causa la quita del fichero', () => {
    const file = healthFile(dir);
    const store = new HealthStore(file);
    store.load();
    store.add('box:image', 1);
    expect(store.remove('box:image')).toBe(true);
    expect(store.remove('box:image')).toBe(false);
    const again = new HealthStore(file);
    again.load();
    expect(again.causes()).toEqual([]);
  });

  it('un fichero de un Stratum más nuevo no se reescribe', () => {
    const file = healthFile(dir);
    const content = JSON.stringify({ schemaVersion: 99, notified: [], future: true });
    writeFileSync(file, content);
    const store = new HealthStore(file);
    store.load();
    expect(store.readOnly).toBe(true);
    store.add('box:image', 1);
    expect(store.has('box:image')).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe(content);
  });

  it('un fichero dañado deja el almacén en memoria', () => {
    const file = healthFile(dir);
    writeFileSync(file, '{ no es json');
    const store = new HealthStore(file);
    store.load();
    expect(store.readOnly).toBe(true);
    store.add('box:image', 1);
    expect(readFileSync(file, 'utf8')).toBe('{ no es json');
  });
});
