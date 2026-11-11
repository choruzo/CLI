import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { z } from 'zod';
import { StratumConfigSchema } from './schema.js';
import { findUnknownKeys } from './unknown-keys.js';
import { loadConfig, takeConfigDeprecations, validateConfigLayer } from './loader.js';

const provider = {
  default: 'nan',
  providers: {
    nan: {
      type: 'openai-compatible',
      baseUrl: 'http://localhost:1/v1',
      model: 'glm',
      models: { glm: { vision: { coordinates: 'pixels' } } },
    },
  },
};

describe('findUnknownKeys', () => {
  it('una config conocida no da nada', () => {
    expect(findUnknownKeys(StratumConfigSchema, { provider, agent: { maxIterations: 5 } })).toEqual(
      [],
    );
  });

  it('encuentra la visión declarada en un "models" de primer nivel (la prueba real de M18)', () => {
    const raw = { provider, models: { 'glm5.3-flash': { vision: {} } } };
    expect(findUnknownKeys(StratumConfigSchema, raw)).toEqual([['models']]);
  });

  it('baja por secciones, mapas y listas', () => {
    const raw = {
      agent: { maxIterations: 5, maxIteratons: 9 },
      provider: {
        ...provider,
        providers: { nan: { ...provider.providers.nan, temperatur: 1 } },
      },
      mcp: { servers: [{ name: 'x', command: 'y', comand: 'z' }] },
    };
    const found = findUnknownKeys(StratumConfigSchema, raw).map((p) => p.join('.'));
    expect(found).toContain('agent.maxIteratons');
    expect(found).toContain('provider.providers.nan.temperatur');
    expect(found).not.toContain('agent.maxIterations');
  });

  it('no avisa de lo que un objeto estricto ya rechaza ni de lo que uno passthrough conserva', () => {
    const schema = z.object({
      strict: z.object({ a: z.number() }).strict(),
      loose: z.object({ a: z.number() }).passthrough(),
      plain: z.object({ a: z.number() }),
    });
    const value = { strict: { a: 1, b: 2 }, loose: { a: 1, b: 2 }, plain: { a: 1, b: 2 } };
    expect(findUnknownKeys(schema, value)).toEqual([['plain', 'b']]);
  });

  it('en una unión mira la opción que valida', () => {
    const schema = z.object({
      u: z.union([z.string(), z.object({ a: z.number() })]),
    });
    expect(findUnknownKeys(schema, { u: 'x' })).toEqual([]);
    expect(findUnknownKeys(schema, { u: { a: 1, b: 2 } })).toEqual([['u', 'b']]);
  });
});

describe('aviso al cargar', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'stratum-unk-'));
    takeConfigDeprecations();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('nombra el fichero y la clave, con la pista de la ruta de un modelo', () => {
    const file = join(dir, '.stratumrc.json');
    writeFileSync(file, JSON.stringify({ models: { glm: { vision: {} } } }));
    loadConfig(dir);
    const warning = takeConfigDeprecations().find((w) => w.startsWith(file));
    expect(warning).toContain('clave desconocida "models"');
    expect(warning).toContain('provider.providers.<alias>.models.<id>');
  });

  it('junta las de un fichero en un aviso', () => {
    const file = join(dir, '.stratumrc.json');
    writeFileSync(file, JSON.stringify({ foo: 1, bar: { baz: 2 } }));
    loadConfig(dir);
    const warnings = takeConfigDeprecations().filter((w) => w.startsWith(file));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('claves desconocidas "foo", "bar"; se ignoran.');
  });

  it('validar una escritura no deja avisos', () => {
    validateConfigLayer(join(dir, 'x.json'), { foo: 1 }, join(dir, 'none.json'));
    expect(takeConfigDeprecations().filter((w) => w.includes('foo'))).toEqual([]);
  });
});
