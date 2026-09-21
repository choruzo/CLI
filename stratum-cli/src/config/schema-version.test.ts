import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  CONFIG_SCHEMA_VERSION,
  SESSION_SCHEMA_VERSION,
  SchemaVersionError,
  assertSchemaVersion,
  checkSchemaVersion,
} from './schema-version.js';
import { loadConfig } from './loader.js';
import { SessionStore } from '../session/store.js';

describe('checkSchemaVersion', () => {
  it('trata la ausencia del campo como versión 1', () => {
    expect(checkSchemaVersion(undefined, 1)).toEqual({ ok: true, version: 1 });
  });

  it('acepta versiones iguales o anteriores a la soportada', () => {
    expect(checkSchemaVersion(1, 3)).toEqual({ ok: true, version: 1 });
    expect(checkSchemaVersion(3, 3)).toEqual({ ok: true, version: 3 });
  });

  it('marca como `newer` una versión posterior', () => {
    expect(checkSchemaVersion(2, 1)).toEqual({ ok: false, version: 2, reason: 'newer' });
  });

  it.each([0, -1, 1.5, '1', null])('marca como `invalid` el valor %j', (value) => {
    expect(checkSchemaVersion(value, 1)).toMatchObject({ ok: false, reason: 'invalid' });
  });
});

describe('assertSchemaVersion', () => {
  it('lanza un SchemaVersionError tipado que nombra el fichero y las dos versiones', () => {
    let caught: unknown;
    try {
      assertSchemaVersion(CONFIG_SCHEMA_VERSION + 1, 'config', '/x/.stratumrc.json');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SchemaVersionError);
    const err = caught as SchemaVersionError;
    expect(err.kind).toBe('config');
    expect(err.found).toBe(CONFIG_SCHEMA_VERSION + 1);
    expect(err.message).toContain('/x/.stratumrc.json');
    expect(err.message).toContain(`schemaVersion ${CONFIG_SCHEMA_VERSION + 1}`);
    expect(err.message).toContain('más nueva');
  });
});

describe('schemaVersion en los ficheros compartidos', () => {
  let dir: string;

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('loadConfig rechaza una config de proyecto de un Stratum más nuevo', () => {
    dir = mkdtempSync(join(tmpdir(), 'stratum-schema-'));
    const path = join(dir, '.stratumrc.json');
    writeFileSync(path, JSON.stringify({ schemaVersion: CONFIG_SCHEMA_VERSION + 1 }));
    expect(() => loadConfig(dir)).toThrow(SchemaVersionError);
  });

  it('loadConfig conserva un schemaVersion compatible en la config parseada', () => {
    dir = mkdtempSync(join(tmpdir(), 'stratum-schema-'));
    writeFileSync(
      join(dir, '.stratumrc.json'),
      JSON.stringify({ schemaVersion: CONFIG_SCHEMA_VERSION }),
    );
    expect(loadConfig(dir).schemaVersion).toBe(CONFIG_SCHEMA_VERSION);
  });

  it('SessionStore escribe la versión actual y rechaza cargar una más nueva', async () => {
    dir = mkdtempSync(join(tmpdir(), 'stratum-schema-'));
    const store = new SessionStore(dir);
    const saved = await store.save({
      provider: 'p',
      model: 'm',
      project: dir,
      messages: [],
      toolCallCount: 0,
    });
    expect(saved.schemaVersion).toBe(SESSION_SCHEMA_VERSION);
    expect(store.load(saved.id).schemaVersion).toBe(SESSION_SCHEMA_VERSION);

    writeFileSync(
      join(dir, `${saved.id}.json`),
      JSON.stringify({ ...saved, schemaVersion: SESSION_SCHEMA_VERSION + 1 }),
    );
    expect(() => store.load(saved.id)).toThrow(SchemaVersionError);
  });
});
