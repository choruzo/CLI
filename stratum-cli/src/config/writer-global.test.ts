import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
  readdirSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { readGlobalConfigSnapshot, setGlobalConfigValue } from './writer.js';

/**
 * `config set|list --global` (Stratum Desktop): siempre el fichero global que
 * se le pasa, nunca uno de proyecto; valores tipados por JSON; nada a medias.
 */
let dir: string;
let globalPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stratum-global-'));
  globalPath = join(dir, 'global', '.stratumrc.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function readJson(path = globalPath): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
}

describe('setGlobalConfigValue', () => {
  it('crea el global si no existe y coerciona el texto como `set`', () => {
    setGlobalConfigValue('desktop.notifications.enabled', 'false', {}, globalPath);
    setGlobalConfigValue('desktop.notifications.minSeconds', '30', {}, globalPath);
    expect(readJson()).toEqual({
      desktop: { notifications: { enabled: false, minSeconds: 30 } },
    });
  });

  it('con json guarda el valor tal cual, sin coerción de texto', () => {
    setGlobalConfigValue('agents.defaultProfile', '"123"', { json: true }, globalPath);
    // «123» sigue siendo una cadena; sin json habría pasado a número y el schema lo rechazaría.
    expect(readJson()['agents']).toEqual({ defaultProfile: '123' });
    expect(() => setGlobalConfigValue('agents.defaultProfile', '456', {}, globalPath)).toThrow();
  });

  it('con json crea un provider entero de una vez', () => {
    setGlobalConfigValue(
      'provider',
      JSON.stringify({
        default: 'local',
        providers: {
          local: {
            type: 'openai-compatible',
            baseUrl: 'http://localhost:11434/v1',
            apiKey: '${K}',
          },
        },
      }),
      { json: true },
      globalPath,
    );
    const provider = readJson()['provider'] as { providers: Record<string, { apiKey: string }> };
    expect(provider.providers['local']?.apiKey).toBe('${K}');
  });

  it('un JSON roto no escribe nada', () => {
    expect(() =>
      setGlobalConfigValue('provider.default', '{no', { json: true }, globalPath),
    ).toThrow('JSON');
    expect(existsSync(globalPath)).toBe(false);
  });

  it('una config inválida lanza y deja el fichero como estaba (sin temporales)', () => {
    setGlobalConfigValue('logging.level', 'debug', {}, globalPath);
    const before = readFileSync(globalPath, 'utf-8');
    expect(() => setGlobalConfigValue('logging.level', 'ruidoso', {}, globalPath)).toThrow();
    expect(readFileSync(globalPath, 'utf-8')).toBe(before);
    expect(readdirSync(join(dir, 'global'))).toEqual(['.stratumrc.json']);
  });

  it('rechaza claves con tramos vacíos o de prototipo', () => {
    for (const key of ['a..b', '.a', '__proto__.x', 'a.constructor']) {
      expect(() => setGlobalConfigValue(key, '1', {}, globalPath)).toThrow('no válida');
    }
    expect(existsSync(globalPath)).toBe(false);
  });

  it('no toca un fichero de un Stratum más nuevo', () => {
    const newer = JSON.stringify({ schemaVersion: 99, logging: { level: 'info' } });
    setGlobalConfigValue('logging.level', 'info', {}, globalPath);
    writeFileSync(globalPath, newer);
    expect(() => setGlobalConfigValue('logging.level', 'debug', {}, globalPath)).toThrow();
    expect(readFileSync(globalPath, 'utf-8')).toBe(newer);
  });

  it('nunca escribe en el .stratumrc.json del directorio de trabajo', () => {
    const project = join(dir, 'proyecto', '.stratumrc.json');
    setGlobalConfigValue('logging.level', 'debug', {}, globalPath);
    expect(existsSync(project)).toBe(false);
    expect(readJson()['logging']).toEqual({ level: 'debug' });
  });
});

describe('readGlobalConfigSnapshot', () => {
  it('sin fichero: crudo vacío, escribible y con los defaults del schema', () => {
    const snap = readGlobalConfigSnapshot(globalPath);
    expect(snap).toMatchObject({ format: 1, path: globalPath, exists: false, writable: true });
    expect(snap.raw).toEqual({});
    const logging = snap.defaults['logging'] as { level: string };
    expect(logging.level).toBe('info');
  });

  it('devuelve el JSON crudo con ${VAR} sin expandir', () => {
    process.env['STRATUM_TEST_SNAP_KEY'] = 'sk-real-secret';
    try {
      setGlobalConfigValue(
        'provider',
        JSON.stringify({
          default: 'p',
          providers: {
            p: {
              type: 'openai-compatible',
              baseUrl: 'http://x/v1',
              apiKey: '${STRATUM_TEST_SNAP_KEY}',
            },
          },
        }),
        { json: true },
        globalPath,
      );
      const text = JSON.stringify(readGlobalConfigSnapshot(globalPath));
      expect(text).toContain('${STRATUM_TEST_SNAP_KEY}');
      expect(text).not.toContain('sk-real-secret');
    } finally {
      delete process.env['STRATUM_TEST_SNAP_KEY'];
    }
  });

  it('marca como no escribible un fichero de un Stratum más nuevo', () => {
    mkdirP(join(dir, 'global'));
    writeFileSync(globalPath, JSON.stringify({ schemaVersion: 99 }));
    const snap = readGlobalConfigSnapshot(globalPath);
    expect(snap.writable).toBe(false);
    expect(snap.supportedSchemaVersion).toBe(1);
  });

  it('un JSON roto lanza un error que nombra el fichero', () => {
    mkdirP(join(dir, 'global'));
    writeFileSync(globalPath, '{ roto');
    expect(() => readGlobalConfigSnapshot(globalPath)).toThrow(globalPath);
  });
});

function mkdirP(path: string): void {
  mkdirSync(path, { recursive: true });
}
