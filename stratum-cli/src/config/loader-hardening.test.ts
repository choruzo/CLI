import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  ConfigError,
  expandEnvVars,
  loadConfig,
  parseConfigText,
  takeConfigDeprecations,
  validateConfigLayer,
  type MissingEnvVar,
} from './loader.js';
import { setConfigValue } from './writer.js';
import { setByDotPath } from './dot-path.js';
import { stripBom } from './json-text.js';

const BOM = String.fromCharCode(0xfeff);

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stratum-cfg-'));
  takeConfigDeprecations();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeJson(path: string, value: unknown, prefix = ''): void {
  writeFileSync(path, prefix + JSON.stringify(value, null, 2));
}

describe('lectura del fichero', () => {
  it('acepta un .stratumrc.json con BOM (Bloc de notas de Windows)', () => {
    writeJson(join(dir, '.stratumrc.json'), { agent: { maxIterations: 7 } }, BOM);
    expect(loadConfig(dir).agent.maxIterations).toBe(7);
  });

  it('un JSON roto nombra el fichero, la línea y la columna', () => {
    const file = join(dir, '.stratumrc.json');
    writeFileSync(file, '{\n  "agent": { "maxIterations": 3, }\n}');
    let error: unknown;
    try {
      loadConfig(dir);
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).message).toContain(file);
    expect((error as Error).message).toMatch(/línea 2, columna \d+/);
  });

  it('una raíz que no es objeto es un error claro', () => {
    expect(() => parseConfigText('[1, 2]', 'x.json')).toThrow(/tiene que ser un objeto JSON/);
    expect(() => parseConfigText('null', 'x.json')).toThrow(ConfigError);
  });

  it('stripBom solo quita el BOM inicial', () => {
    expect(stripBom(`${BOM}{}`)).toBe('{}');
    expect(stripBom(`{}${BOM}`)).toBe(`{}${BOM}`);
  });
});

describe('errores de validación', () => {
  it('listan la clave, el motivo y el fichero que la define', () => {
    const file = join(dir, '.stratumrc.json');
    writeJson(file, { agent: { maxIterations: -1 } });
    expect(() => loadConfig(dir)).toThrow(ConfigError);
    try {
      loadConfig(dir);
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain('La config no es válida');
      expect(message).toContain('agent.maxIterations');
      expect(message).toContain(file);
      expect(message).not.toContain('"code"'); // nada de volcado JSON del ZodError
    }
  });

  it('atribuyen el error a la capa de proyecto cuando es ella quien lo trae', () => {
    const globalFile = join(dir, 'global.json');
    const projectFile = join(dir, 'project.json');
    writeJson(globalFile, { agent: { maxIterations: 10 } });
    try {
      validateConfigLayer(projectFile, { agent: { maxIterations: 'mucho' } }, globalFile);
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).toContain(`[${projectFile}]`);
      expect((err as Error).message).not.toContain(`[${globalFile}]`);
    }
  });
});

describe('variables de entorno', () => {
  it('una variable no definida avisa una vez, con fichero y clave', () => {
    const file = join(dir, '.stratumrc.json');
    writeJson(file, {
      provider: {
        default: 'p',
        providers: {
          p: {
            type: 'openai-compatible',
            baseUrl: 'http://localhost:1/v1',
            model: 'm',
            apiKey: '${STRATUM_TEST_NOPE_XYZ}',
          },
          q: {
            type: 'openai-compatible',
            baseUrl: 'http://localhost:2/v1',
            model: 'm',
            apiKey: '${STRATUM_TEST_NOPE_XYZ}',
          },
        },
      },
    });
    const config = loadConfig(dir);
    expect(config.provider?.providers['p']!.apiKey).toBe('');
    const warnings = takeConfigDeprecations().filter((w) => w.includes('STRATUM_TEST_NOPE_XYZ'));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(file);
    expect(warnings[0]).toContain('provider.providers.p.apiKey');
  });

  it('expandEnvVars informa la ruta de cada referencia sin definir', () => {
    const missing: MissingEnvVar[] = [];
    expandEnvVars({ a: [{ b: 'x-${NOPE_1}' }], c: '${NOPE_2}' }, (m) => missing.push(m));
    expect(missing).toEqual([
      { name: 'NOPE_1', path: 'a.0.b' },
      { name: 'NOPE_2', path: 'c' },
    ]);
  });
});

describe('validateConfigLayer', () => {
  const host = { host: 'h', user: 'u', password: 'x' };

  it('una capa de proyecto se valida fusionada con la global', () => {
    const globalFile = join(dir, 'global.json');
    writeJson(globalFile, { ssh: { hosts: { bastion: host } } });
    const project = { ssh: { hosts: { app: { ...host, jumpHost: 'bastion' } } } };
    // Sola sería inválida (jumpHost inexistente); con la global, no.
    expect(() =>
      validateConfigLayer(join(dir, 'solo.json'), project, join(dir, 'none.json')),
    ).toThrow(ConfigError);
    expect(() => validateConfigLayer(join(dir, 'p.json'), project, globalFile)).not.toThrow();
  });

  it('la global se valida sola', () => {
    const globalFile = join(dir, 'global.json');
    writeJson(globalFile, {});
    expect(() =>
      validateConfigLayer(
        globalFile,
        { ssh: { hosts: { app: { ...host, jumpHost: 'x' } } } },
        globalFile,
      ),
    ).toThrow(ConfigError);
  });
});

describe('setConfigValue', () => {
  it('escribe en el .stratumrc.json del proyecto aunque tenga BOM', () => {
    const file = join(dir, '.stratumrc.json');
    writeJson(file, { agent: { maxIterations: 3 } }, BOM);
    expect(setConfigValue('agent.maxIterations', '9', dir)).toBe(file);
    expect(JSON.parse(readFileSync(file, 'utf-8'))).toEqual({ agent: { maxIterations: 9 } });
  });

  it('un valor inválido no toca el fichero', () => {
    const file = join(dir, '.stratumrc.json');
    writeJson(file, { agent: { maxIterations: 3 } });
    const before = readFileSync(file, 'utf-8');
    expect(() => setConfigValue('agent.maxIterations', '-5', dir)).toThrow(ConfigError);
    expect(readFileSync(file, 'utf-8')).toBe(before);
  });

  it('conserva los ${VAR} sin expandir al reescribir', () => {
    const file = join(dir, '.stratumrc.json');
    writeJson(file, { tools: { webSearch: { tavilyApiKey: '${TAVILY_KEY_X}' } } });
    setConfigValue('agent.maxIterations', '4', dir);
    expect(readFileSync(file, 'utf-8')).toContain('${TAVILY_KEY_X}');
  });
});

describe('setByDotPath', () => {
  it('rechaza claves que escribirían en el prototipo o vacías', () => {
    for (const key of ['__proto__.polluted', 'a.constructor.x', 'a..b', '.a']) {
      expect(() => setByDotPath({}, key, '1')).toThrow(/no válida/);
    }
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });
});
