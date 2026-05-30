import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { expandEnvVars, findConfigFile, loadConfig } from './loader.js';

describe('expandEnvVars', () => {
  beforeEach(() => {
    process.env.TEST_API_KEY = 'secret-key-123';
  });

  afterEach(() => {
    delete process.env.TEST_API_KEY;
  });

  it('expande referencias ${VAR} desde process.env', () => {
    expect(expandEnvVars('${TEST_API_KEY}')).toBe('secret-key-123');
  });

  it('deja strings sin ${} sin cambios', () => {
    expect(expandEnvVars('sin-variables')).toBe('sin-variables');
  });

  it('devuelve cadena vacía para variables no definidas', () => {
    expect(expandEnvVars('${UNDEFINED_VAR_XYZ}')).toBe('');
  });

  it('expande variables en objetos anidados recursivamente', () => {
    const input = {
      level1: {
        apiKey: '${TEST_API_KEY}',
        nested: {
          value: 'prefix-${TEST_API_KEY}-suffix',
        },
      },
    };
    const result = expandEnvVars(input) as typeof input;
    expect(result.level1.apiKey).toBe('secret-key-123');
    expect(result.level1.nested.value).toBe('prefix-secret-key-123-suffix');
  });

  it('expande variables en arrays', () => {
    const result = expandEnvVars(['${TEST_API_KEY}', 'literal']) as string[];
    expect(result[0]).toBe('secret-key-123');
    expect(result[1]).toBe('literal');
  });

  it('pasa números y booleanos sin modificar', () => {
    expect(expandEnvVars(42)).toBe(42);
    expect(expandEnvVars(true)).toBe(true);
    expect(expandEnvVars(null)).toBe(null);
  });
});

describe('findConfigFile', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `stratum-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('encuentra el archivo en el directorio actual', () => {
    writeFileSync(join(tmpDir, '.stratumrc.json'), '{}');
    expect(findConfigFile(tmpDir)).toBe(join(tmpDir, '.stratumrc.json'));
  });

  it('encuentra el archivo en un directorio padre', () => {
    const subDir = join(tmpDir, 'sub', 'dir');
    mkdirSync(subDir, { recursive: true });
    writeFileSync(join(tmpDir, '.stratumrc.json'), '{}');
    expect(findConfigFile(subDir)).toBe(join(tmpDir, '.stratumrc.json'));
  });

  it('retorna null si no existe .stratumrc.json en ningún padre', () => {
    const subDir = join(tmpDir, 'orphan');
    mkdirSync(subDir, { recursive: true });
    expect(findConfigFile(subDir)).toBeNull();
  });
});

describe('loadConfig', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `stratum-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('retorna defaults cuando no existe .stratumrc.json', () => {
    const config = loadConfig(tmpDir);
    expect(config.agent.maxIterations).toBe(50);
    expect(config.tools.confirmDestructive).toBe(true);
    expect(config.memory.retrievalTopK).toBe(5);
  });

  it('carga y valida una config válida', () => {
    const raw = {
      provider: {
        default: 'local',
        providers: {
          local: {
            type: 'openai-compatible',
            baseUrl: 'http://localhost:11434/v1',
            model: 'qwen3.5:9b',
          },
        },
      },
      agent: { maxIterations: 25 },
    };
    writeFileSync(join(tmpDir, '.stratumrc.json'), JSON.stringify(raw));

    const config = loadConfig(tmpDir);
    expect(config.provider?.default).toBe('local');
    expect(config.agent.maxIterations).toBe(25);
    expect(config.tools.confirmDestructive).toBe(true);
  });

  it('lanza ZodError con config inválida', () => {
    writeFileSync(
      join(tmpDir, '.stratumrc.json'),
      JSON.stringify({ agent: { maxIterations: -1 } }),
    );
    expect(() => loadConfig(tmpDir)).toThrow();
  });

  it('expande variables de entorno en la config', () => {
    process.env.TEST_STRATUM_KEY = 'my-api-key';
    const raw = {
      provider: {
        default: 'remote',
        providers: {
          remote: {
            type: 'openai-compatible',
            baseUrl: 'http://localhost:4000/v1',
            model: 'claude-sonnet-4-5',
            apiKey: '${TEST_STRATUM_KEY}',
          },
        },
      },
    };
    writeFileSync(join(tmpDir, '.stratumrc.json'), JSON.stringify(raw));

    const config = loadConfig(tmpDir);
    expect(config.provider?.providers['remote'].apiKey).toBe('my-api-key');
    delete process.env.TEST_STRATUM_KEY;
  });
});
