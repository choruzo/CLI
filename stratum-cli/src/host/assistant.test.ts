import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { importLegacyGlobalDecisions } from './assistant.js';
import { DecisionStore, type DecisionInput } from '../memory/decisions.js';

const input: DecisionInput = {
  title: 'Usar sqlite-vec',
  content: 'Embebido y sin servidor.',
  type: 'architectural',
  tags: ['database'],
  importance: 'high',
};

describe('importLegacyGlobalDecisions', () => {
  let base: string;
  let legacy: string;
  let data: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'stratum-legacy-'));
    legacy = join(base, 'legacy');
    data = join(base, 'assistant');
    mkdirSync(legacy, { recursive: true });
    mkdirSync(data, { recursive: true });
  });
  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  const source = (): string => join(legacy, 'decisions.json');
  const mark = (): string => join(legacy, '.imported-to-assistant');
  const target = (): DecisionStore => new DecisionStore(join(data, 'memory', 'decisions.json'));

  it('sin fichero legado devuelve 0 y no deja marca', () => {
    expect(importLegacyGlobalDecisions(data, legacy)).toBe(0);
    expect(existsSync(mark())).toBe(false);
  });

  it('importa a la memoria del asistente y escribe la marca', () => {
    const rec = new DecisionStore(source()).add(input);
    expect(importLegacyGlobalDecisions(data, legacy)).toBe(1);
    expect(
      target()
        .load()
        .map((r) => r.id),
    ).toEqual([rec.id]);
    expect(existsSync(mark())).toBe(true);
  });

  it('la segunda llamada devuelve 0 por la marca', () => {
    new DecisionStore(source()).add(input);
    expect(importLegacyGlobalDecisions(data, legacy)).toBe(1);
    new DecisionStore(source()).add(input);
    expect(importLegacyGlobalDecisions(data, legacy)).toBe(0);
    expect(target().load()).toHaveLength(1);
  });

  it('fusiona con lo que el asistente ya tenía sin duplicar ids', () => {
    const shared = new DecisionStore(source()).add(input);
    const only = new DecisionStore(source()).add({ ...input, title: 'Otra' });
    const own = target();
    own.importMissing([shared]);
    const mine = own.add({ ...input, title: 'Propia del asistente' });

    expect(importLegacyGlobalDecisions(data, legacy)).toBe(1);
    const ids = target()
      .load()
      .map((r) => r.id);
    expect(ids).toHaveLength(3);
    expect(new Set(ids)).toEqual(new Set([shared.id, only.id, mine.id]));
  });

  it('el original queda byte a byte igual', () => {
    new DecisionStore(source()).add(input);
    const before = readFileSync(source());
    importLegacyGlobalDecisions(data, legacy);
    expect(readFileSync(source()).equals(before)).toBe(true);
  });

  it('un legado vacío devuelve 0 y no deja marca', () => {
    writeFileSync(source(), '[]', 'utf-8');
    expect(importLegacyGlobalDecisions(data, legacy)).toBe(0);
    expect(existsSync(mark())).toBe(false);
  });

  it('un destino de un Stratum más nuevo: 0, sin marca y sin lanzar', () => {
    new DecisionStore(source()).add(input);
    mkdirSync(join(data, 'memory'), { recursive: true });
    const newer = JSON.stringify({ schemaVersion: 99, decisions: [] });
    writeFileSync(join(data, 'memory', 'decisions.json'), newer, 'utf-8');

    expect(importLegacyGlobalDecisions(data, legacy)).toBe(0);
    expect(existsSync(mark())).toBe(false);
    expect(readFileSync(join(data, 'memory', 'decisions.json'), 'utf-8')).toBe(newer);
  });
});
