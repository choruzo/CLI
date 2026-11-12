import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { parseConnectorManifest, type ConnectorManifest } from './manifest.js';
import {
  ConnectorSecretsError,
  clearConnectorSecrets,
  connectorSecretsPath,
  readConnectorSecrets,
  secretValueProblem,
  secretValuesFor,
  secretsStatusOf,
  setConnectorSecrets,
} from './secrets.js';

let dir: string;
beforeEach(() => {
  dir = join(mkdtempSync(join(tmpdir(), 'stratum-secrets-')), 'daemon');
});
afterEach(() => rmSync(join(dir, '..'), { recursive: true, force: true }));

function manifest(id = 'casa', secrets = ['CASA_URL', 'CASA_TOKEN']): ConnectorManifest {
  return parseConnectorManifest(
    {
      schemaVersion: 1,
      id,
      version: '1.0.0',
      name: id,
      description: 'x',
      agents: ['companion'],
      hosts: [],
      secrets: secrets.map((name, i) =>
        i === 0 ? { name, description: 'url', sensitive: false } : { name, description: 'd' },
      ),
      tools: [{ name: 'leer', readOnly: true, summary: 's' }],
    },
    'test',
  );
}

describe('connector-secrets.json (M20 fase 4)', () => {
  it('sin fichero: ausente y todo falta', () => {
    const state = readConnectorSecrets(dir);
    expect(state).toEqual({ state: 'absent' });
    expect(secretsStatusOf(manifest(), state)).toEqual({ missing: ['CASA_URL', 'CASA_TOKEN'] });
    expect(secretValuesFor(manifest(), state)).toBeNull();
    // Un conector sin secretos no necesita nada.
    expect(secretValuesFor(manifest('libre', []), state)).toEqual({});
  });

  it('guarda, suma y lee; en la carpeta privada', () => {
    const m = manifest();
    const path = setConnectorSecrets(dir, m, { CASA_URL: 'http://casa.home:8123' });
    expect(path).toBe(connectorSecretsPath(dir));
    expect(secretsStatusOf(m, readConnectorSecrets(dir)).missing).toEqual(['CASA_TOKEN']);
    setConnectorSecrets(dir, m, { CASA_TOKEN: 'tok' });
    expect(secretValuesFor(m, readConnectorSecrets(dir))).toEqual({
      CASA_URL: 'http://casa.home:8123',
      CASA_TOKEN: 'tok',
    });
    if (process.platform !== 'win32') {
      expect(statSync(path).mode & 0o077).toBe(0);
      expect(statSync(dir).mode & 0o077).toBe(0);
    }
  });

  it('solo da los nombres del manifiesto', () => {
    const m = manifest();
    setConnectorSecrets(dir, m, { CASA_URL: 'u', CASA_TOKEN: 't' });
    // Otro conector con un nombre igual no recibe los de este.
    expect(secretValuesFor(manifest('otra', ['CASA_URL']), readConnectorSecrets(dir))).toBeNull();
  });

  it('rechaza nombres que no pide y valores con salto de línea', () => {
    const m = manifest();
    expect(() => setConnectorSecrets(dir, m, { OTRO: 'x' })).toThrow(ConnectorSecretsError);
    expect(() => setConnectorSecrets(dir, m, { CASA_TOKEN: 'a\nb' })).toThrow(/line breaks/);
    expect(secretValueProblem('')).toMatch(/empty/);
    expect(secretValueProblem('ok')).toBeNull();
    expect(readConnectorSecrets(dir)).toEqual({ state: 'absent' });
  });

  it('borra uno o todos los de un conector', () => {
    const m = manifest();
    setConnectorSecrets(dir, m, { CASA_URL: 'u', CASA_TOKEN: 't' });
    expect(clearConnectorSecrets(dir, 'casa', 'CASA_TOKEN')).toBe(true);
    expect(secretsStatusOf(m, readConnectorSecrets(dir)).missing).toEqual(['CASA_TOKEN']);
    expect(clearConnectorSecrets(dir, 'casa', 'CASA_TOKEN')).toBe(false);
    expect(clearConnectorSecrets(dir, 'casa')).toBe(true);
    expect(clearConnectorSecrets(dir, 'casa')).toBe(false);
    const state = readConnectorSecrets(dir);
    expect(state.state === 'ok' && state.file.connectors).toEqual({});
  });

  it('uno inválido no da nada y no se reescribe; uno más nuevo tampoco', () => {
    const m = manifest();
    mkdirSync(dir, { recursive: true });
    writeFileSync(connectorSecretsPath(dir), '{ roto');
    const bad = readConnectorSecrets(dir);
    expect(bad).toEqual({ state: 'invalid' });
    expect(secretsStatusOf(m, bad)).toEqual({
      missing: ['CASA_URL', 'CASA_TOKEN'],
      unusable: 'invalid',
    });
    expect(secretValuesFor(m, bad)).toBeNull();
    expect(() => setConnectorSecrets(dir, m, { CASA_TOKEN: 't' })).toThrow(/not valid/);
    expect(readFileSync(connectorSecretsPath(dir), 'utf8')).toBe('{ roto');

    const newer = JSON.stringify({ schemaVersion: 2, connectors: {}, updatedAt: 'x' });
    writeFileSync(connectorSecretsPath(dir), newer);
    expect(readConnectorSecrets(dir)).toEqual({ state: 'newer', schemaVersion: 2 });
    expect(() => clearConnectorSecrets(dir, 'casa')).toThrow(/newer/);
    expect(readFileSync(connectorSecretsPath(dir), 'utf8')).toBe(newer);
  });
});
