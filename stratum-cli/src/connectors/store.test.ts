import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  CONNECTORS_FILE,
  ConnectorsStoreError,
  connectorsFile,
  disableConnector,
  enableConnector,
  enabledConnectorIds,
  readConnectorsFile,
} from './store.js';

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stratum-connectors-'));
  file = connectorsFile(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('connectors.json (M20)', () => {
  it('sin fichero: absent y ningún id', () => {
    expect(file.endsWith(CONNECTORS_FILE)).toBe(true);
    expect(readConnectorsFile(file)).toEqual({ state: 'absent' });
    expect(enabledConnectorIds(file)).toEqual([]);
  });

  it('enable escribe con schemaVersion, es idempotente y no deja temporales', () => {
    const at = new Date('2026-11-11T10:00:00.000Z');
    expect(enableConnector(file, 'open-meteo', at)).toBe(true);
    expect(enableConnector(file, 'open-meteo', new Date())).toBe(false);
    const raw = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>;
    expect(raw).toEqual({
      schemaVersion: 1,
      enabled: [{ id: 'open-meteo', enabledAt: '2026-11-11T10:00:00.000Z' }],
    });
    expect(readdirSync(dir)).toEqual([CONNECTORS_FILE]);
    expect(enabledConnectorIds(file)).toEqual(['open-meteo']);
  });

  it('disable es idempotente', () => {
    enableConnector(file, 'open-meteo');
    enableConnector(file, 'otro-uno');
    expect(disableConnector(file, 'open-meteo')).toBe(true);
    expect(disableConnector(file, 'open-meteo')).toBe(false);
    expect(enabledConnectorIds(file)).toEqual(['otro-uno']);
  });

  it('disable sin fichero no lo crea', () => {
    expect(disableConnector(file, 'open-meteo')).toBe(false);
    expect(readConnectorsFile(file)).toEqual({ state: 'absent' });
  });

  it('un id repetido se queda con la primera aparición', () => {
    writeFileSync(
      file,
      JSON.stringify({
        schemaVersion: 1,
        enabled: [
          { id: 'open-meteo', enabledAt: 'a' },
          { id: 'open-meteo', enabledAt: 'b' },
        ],
      }),
    );
    expect(readConnectorsFile(file)).toEqual({
      state: 'ok',
      enabled: [{ id: 'open-meteo', enabledAt: 'a' }],
    });
  });

  it('un fichero de un Stratum más nuevo no se reescribe y no activa nada', () => {
    const text = JSON.stringify({
      schemaVersion: 99,
      enabled: [{ id: 'open-meteo', enabledAt: 'a' }],
    });
    writeFileSync(file, text);
    expect(readConnectorsFile(file).state).toBe('newer');
    expect(enabledConnectorIds(file)).toEqual([]);
    expect(() => enableConnector(file, 'otro-uno')).toThrow(ConnectorsStoreError);
    expect(() => disableConnector(file, 'open-meteo')).toThrow(ConnectorsStoreError);
    expect(readFileSync(file, 'utf-8')).toBe(text);
  });

  it('JSON roto o inválido: no se reescribe y no activa nada', () => {
    writeFileSync(file, '{ no es json');
    expect(readConnectorsFile(file).state).toBe('unreadable');
    expect(enabledConnectorIds(file)).toEqual([]);
    expect(() => enableConnector(file, 'open-meteo')).toThrow(ConnectorsStoreError);
    expect(readFileSync(file, 'utf-8')).toBe('{ no es json');

    const bad = JSON.stringify({ schemaVersion: 1, enabled: [{ id: '../x', enabledAt: 'a' }] });
    writeFileSync(file, bad);
    expect(readConnectorsFile(file).state).toBe('invalid');
    expect(enabledConnectorIds(file)).toEqual([]);
    expect(() => disableConnector(file, 'open-meteo')).toThrow(ConnectorsStoreError);
    expect(readFileSync(file, 'utf-8')).toBe(bad);
  });
});
