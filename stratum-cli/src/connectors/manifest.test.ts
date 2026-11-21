import { describe, it, expect } from 'vitest';
import {
  CONNECTOR_ID_RE,
  accessCheckOf,
  checksOf,
  parseConnectorManifest,
  readOnlyToolsOf,
} from './manifest.js';

const valid = () => ({
  schemaVersion: 1,
  id: 'open-meteo',
  version: '1.2.3',
  name: 'Open-Meteo',
  description: 'Tiempo',
  agents: ['companion'],
  hosts: ['api.open-meteo.com'],
  secrets: [{ name: 'API_KEY', description: 'La clave' }],
  tools: [
    { name: 'leer', readOnly: true, summary: 'Lee' },
    { name: 'escribir', readOnly: false, summary: 'Escribe' },
  ],
});

describe('parseConnectorManifest (M20)', () => {
  it('acepta un manifiesto válido', () => {
    const m = parseConnectorManifest(valid(), 'x');
    expect(m.id).toBe('open-meteo');
    expect(m.tools).toHaveLength(2);
  });

  it('oauth (M21): sus tres nombres son secretos distintos y los ámbitos, de Google', () => {
    const withOAuth = (oauth: Record<string, unknown>) => ({
      ...valid(),
      secrets: [
        { name: 'C_ID', description: 'x' },
        { name: 'C_SECRET', description: 'x' },
        { name: 'C_TOKEN', description: 'x' },
      ],
      oauth: {
        provider: 'google',
        scopes: ['https://www.googleapis.com/auth/tasks'],
        clientId: 'C_ID',
        clientSecret: 'C_SECRET',
        refreshToken: 'C_TOKEN',
        ...oauth,
      },
    });
    expect(parseConnectorManifest(withOAuth({}), 'x').oauth?.provider).toBe('google');
    expect(() => parseConnectorManifest(withOAuth({ refreshToken: 'OTRO' }), 'x')).toThrow(
      /not a secret/,
    );
    expect(() => parseConnectorManifest(withOAuth({ refreshToken: 'C_ID' }), 'x')).toThrow(
      /repeated/,
    );
    expect(() =>
      parseConnectorManifest(withOAuth({ scopes: ['https://evil.example/auth/x'] }), 'x'),
    ).toThrow();
    expect(() => parseConnectorManifest(withOAuth({ provider: 'github' }), 'x')).toThrow();
    // Ni la URL de token ni la de autorización salen del manifiesto.
    expect(() =>
      parseConnectorManifest(withOAuth({ tokenUrl: 'https://evil.example/token' }), 'x'),
    ).toThrow();
  });

  it('checks (M22): solo sobre una tool de solo lectura, sin repetir, con argumentos cerrados', () => {
    const arg = { name: 'entity_id', type: 'string', required: true, description: 'Entidad' };
    const withChecks = (checks: unknown) => ({ ...valid(), checks });
    const ok = { tool: 'leer', summary: 'Mira', minIntervalSec: 60, args: [arg] };
    const m = parseConnectorManifest(withChecks([ok]), 'x');
    expect(checksOf(m)).toHaveLength(1);
    expect(checksOf(parseConnectorManifest(valid(), 'x'))).toEqual([]);

    expect(() => parseConnectorManifest(withChecks([{ ...ok, tool: 'otra' }]), 'x')).toThrow(
      /not a tool/,
    );
    expect(() => parseConnectorManifest(withChecks([{ ...ok, tool: 'escribir' }]), 'x')).toThrow(
      /not a read-only tool/,
    );
    expect(() => parseConnectorManifest(withChecks([ok, ok]), 'x')).toThrow(/duplicate check/);
    expect(() => parseConnectorManifest(withChecks([{ ...ok, args: [arg, arg] }]), 'x')).toThrow(
      /repeats an argument/,
    );
    // Nunca menos de un minuto.
    expect(() =>
      parseConnectorManifest(withChecks([{ ...ok, minIntervalSec: 30 }]), 'x'),
    ).toThrow();
    // Los argumentos son cerrados: sin claves libres ni restricciones de otro tipo.
    for (const bad of [
      { ...arg, format: 'uri' },
      { ...arg, type: 'object' },
      { ...arg, minimum: 1 },
      { ...arg, type: 'number', pattern: 'x' },
      { ...arg, type: 'number', minimum: 5, maximum: 1 },
      { ...arg, pattern: '(' },
    ]) {
      expect(() => parseConnectorManifest(withChecks([{ ...ok, args: [bad] }]), 'x')).toThrow();
    }
  });

  it('access (M23): una check declarada y sin argumentos', () => {
    const okCheck = { tool: 'leer', summary: 'Mira', minIntervalSec: 300, args: [] };
    const base = { ...valid(), checks: [okCheck] };
    expect(accessCheckOf(parseConnectorManifest({ ...base, access: 'leer' }, 'x'))).toBe('leer');
    expect(accessCheckOf(parseConnectorManifest(base, 'x'))).toBeNull();

    // No es una check declarada (aunque sea una tool).
    expect(() => parseConnectorManifest({ ...base, access: 'escribir' }, 'x')).toThrow(
      /not a declared check/,
    );
    expect(() => parseConnectorManifest({ ...valid(), access: 'leer' }, 'x')).toThrow(
      /not a declared check/,
    );
    // Con argumentos no vale.
    const arg = { name: 'q', type: 'string', required: false, description: 'Algo' };
    expect(() =>
      parseConnectorManifest(
        { ...valid(), checks: [{ ...okCheck, args: [arg] }], access: 'leer' },
        'x',
      ),
    ).toThrow(/no arguments/);
    // Nombre mal formado.
    expect(() => parseConnectorManifest({ ...base, access: 'Leer!' }, 'x')).toThrow();
  });

  it('readOnlyToolsOf devuelve solo las de lectura', () => {
    expect(readOnlyToolsOf(parseConnectorManifest(valid(), 'x'))).toEqual(['leer']);
  });

  it('el id es cerrado: nada de mayúsculas, rutas ni espacios', () => {
    for (const id of [
      'a',
      'ab',
      'A-b',
      'ab/c',
      '../x',
      'a b',
      '1abc',
      'abc-',
      '-abc',
      'a'.repeat(40),
    ]) {
      expect(CONNECTOR_ID_RE.test(id), id).toBe(false);
      expect(() => parseConnectorManifest({ ...valid(), id }, 'x')).toThrow(
        /Invalid connector manifest/,
      );
    }
    for (const id of ['abc', 'open-meteo', 'a1-b2']) expect(CONNECTOR_ID_RE.test(id)).toBe(true);
  });

  it('rechaza schemaVersion distinta, claves desconocidas y agentes que no son companion', () => {
    expect(() => parseConnectorManifest({ ...valid(), schemaVersion: 2 }, 'x')).toThrow();
    expect(() => parseConnectorManifest({ ...valid(), extra: 1 }, 'x')).toThrow();
    expect(() => parseConnectorManifest({ ...valid(), agents: ['coding'] }, 'x')).toThrow();
    expect(() => parseConnectorManifest({ ...valid(), agents: [] }, 'x')).toThrow();
  });

  it('rechaza version no semver, tools vacías o duplicadas y secretos mal nombrados', () => {
    expect(() => parseConnectorManifest({ ...valid(), version: '1.0' }, 'x')).toThrow();
    expect(() => parseConnectorManifest({ ...valid(), tools: [] }, 'x')).toThrow();
    const dup = [valid().tools[0]!, valid().tools[0]!];
    expect(() => parseConnectorManifest({ ...valid(), tools: dup }, 'x')).toThrow(/duplicate tool/);
    expect(() =>
      parseConnectorManifest({ ...valid(), secrets: [{ name: 'api_key', description: 'x' }] }, 'x'),
    ).toThrow();
  });

  it('el mensaje de error incluye el origen y la ruta del fallo', () => {
    expect(() => parseConnectorManifest({ ...valid(), version: 'x' }, 'mi/connector.json')).toThrow(
      /mi\/connector\.json: version/,
    );
  });

  it('una tool sin readOnly explícito es inválida (no se asume)', () => {
    const tools = [{ name: 'leer', summary: 'Lee' }];
    expect(() => parseConnectorManifest({ ...valid(), tools }, 'x')).toThrow();
  });
});
