import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { upsertProvider, removeProvider, setDefaultProvider, readRawProvider } from './writer.js';
import type { ProviderConfig } from './schema.js';

const PROVIDER_A: ProviderConfig = {
  type: 'openai-compatible',
  baseUrl: 'http://localhost:11434/v1',
  model: 'qwen2.5-coder:32b',
  apiKey: 'ollama',
  contextWindow: 32768,
};

const PROVIDER_B: ProviderConfig = {
  type: 'openai-compatible',
  baseUrl: 'http://localhost:4000/v1',
  model: 'claude-sonnet-4-5',
  apiKey: '${LITELLM_API_KEY}',
  contextWindow: 200000,
};

let dir: string;
let configPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stratum-writer-'));
  configPath = join(dir, '.stratumrc.json');
  process.env['LITELLM_API_KEY'] = 'sk-test';
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env['LITELLM_API_KEY'];
});

function readJson(): Record<string, unknown> {
  return JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
}

describe('upsertProvider', () => {
  it('crea .stratumrc.json desde cero y fija el default', () => {
    const result = upsertProvider('mi-ollama', PROVIDER_A, true, configPath);

    expect(result.created).toBe(true);
    expect(result.backupPath).toBeNull();
    const raw = readJson();
    const provider = raw['provider'] as { default: string; providers: Record<string, unknown> };
    expect(provider.default).toBe('mi-ollama');
    expect(provider.providers['mi-ollama']).toMatchObject({ model: 'qwen2.5-coder:32b' });
  });

  it('añade un provider sin tocar los existentes y hace backup', () => {
    upsertProvider('mi-ollama', PROVIDER_A, true, configPath);
    const result = upsertProvider('litellm-prod', PROVIDER_B, false, configPath);

    expect(result.created).toBe(false);
    expect(result.backupPath).toBe(`${configPath}.bak`);
    expect(existsSync(`${configPath}.bak`)).toBe(true);

    const raw = readJson();
    const provider = raw['provider'] as { default: string; providers: Record<string, unknown> };
    expect(provider.default).toBe('mi-ollama'); // no cambió
    expect(Object.keys(provider.providers)).toEqual(['mi-ollama', 'litellm-prod']);
    // el backup contiene el estado anterior
    const backup = JSON.parse(readFileSync(`${configPath}.bak`, 'utf-8')) as Record<
      string,
      unknown
    >;
    const backupProviders = (backup['provider'] as { providers: Record<string, unknown> })
      .providers;
    expect(Object.keys(backupProviders)).toEqual(['mi-ollama']);
  });

  it('preserva placeholders ${VAR} sin expandir en disco', () => {
    upsertProvider('litellm-prod', PROVIDER_B, true, configPath);
    const text = readFileSync(configPath, 'utf-8');
    expect(text).toContain('${LITELLM_API_KEY}');
    expect(text).not.toContain('sk-test');
  });

  it('hace default al primer provider aunque makeDefault sea false', () => {
    upsertProvider('solo', PROVIDER_A, false, configPath);
    const provider = readJson()['provider'] as { default: string };
    expect(provider.default).toBe('solo');
  });

  it('preserva el resto de la config existente', () => {
    writeFileSync(configPath, JSON.stringify({ agent: { maxIterations: 10 } }), 'utf-8');
    upsertProvider('mi-ollama', PROVIDER_A, true, configPath);
    expect(readJson()['agent']).toEqual({ maxIterations: 10 });
  });

  it('rechaza una config que quedaría inválida', () => {
    const invalid = { ...PROVIDER_A, baseUrl: 'no-es-una-url' };
    expect(() => upsertProvider('x', invalid, true, configPath)).toThrow();
    expect(existsSync(configPath)).toBe(false); // no escribió nada
  });
});

describe('removeProvider', () => {
  it('elimina un provider y promueve un nuevo default si era el activo', () => {
    upsertProvider('a', PROVIDER_A, true, configPath);
    upsertProvider('b', PROVIDER_B, false, configPath);

    const result = removeProvider('a', configPath);
    expect(result.newDefault).toBe('b');
    const provider = readJson()['provider'] as {
      default: string;
      providers: Record<string, unknown>;
    };
    expect(provider.default).toBe('b');
    expect(Object.keys(provider.providers)).toEqual(['b']);
  });

  it('elimina el bloque provider completo si no quedan providers', () => {
    upsertProvider('a', PROVIDER_A, true, configPath);
    removeProvider('a', configPath);
    expect(readJson()['provider']).toBeUndefined();
  });

  it('lanza si el provider no existe', () => {
    upsertProvider('a', PROVIDER_A, true, configPath);
    expect(() => removeProvider('zzz', configPath)).toThrow('no existe');
  });
});

describe('setDefaultProvider', () => {
  it('cambia el default y hace backup', () => {
    upsertProvider('a', PROVIDER_A, true, configPath);
    upsertProvider('b', PROVIDER_B, false, configPath);

    const result = setDefaultProvider('b', configPath);
    expect(result.backupPath).toBe(`${configPath}.bak`);
    const provider = readJson()['provider'] as { default: string };
    expect(provider.default).toBe('b');
  });

  it('lanza si el provider no existe', () => {
    upsertProvider('a', PROVIDER_A, true, configPath);
    expect(() => setDefaultProvider('zzz', configPath)).toThrow('no existe');
  });
});

describe('readRawProvider', () => {
  it('devuelve el bloque crudo con placeholders sin expandir', () => {
    upsertProvider('litellm-prod', PROVIDER_B, true, configPath);
    const raw = readRawProvider('litellm-prod', configPath);
    expect(raw?.['apiKey']).toBe('${LITELLM_API_KEY}');
  });

  it('devuelve null si no existe', () => {
    upsertProvider('a', PROVIDER_A, true, configPath);
    expect(readRawProvider('zzz', configPath)).toBeNull();
  });
});
