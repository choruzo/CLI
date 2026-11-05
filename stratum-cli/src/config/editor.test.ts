import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  CONFIG_SECTIONS,
  displayValue,
  fieldKind,
  fieldValue,
  parseFieldInput,
  readConfigLayers,
  schemaAt,
  writeField,
} from './editor.js';

describe('fieldKind', () => {
  const kindOf = (key: string) => fieldKind(schemaAt(key)!);

  it('saca el editor del schema', () => {
    expect(kindOf('agent.maxIterations')).toEqual({ kind: 'number', int: true, min: 0 });
    expect(kindOf('tools.confirmDestructive')).toEqual({ kind: 'boolean' });
    expect(kindOf('tui.verbosity')).toEqual({
      kind: 'enum',
      options: ['compact', 'standard', 'verbose'],
    });
    expect(kindOf('tools.testCommand')).toEqual({ kind: 'string' });
    expect(kindOf('tools.auditLog')).toEqual({ kind: 'mixed' });
    expect(kindOf('tools.guardedCommands')).toEqual({ kind: 'complex' });
    expect(kindOf('agent').kind).toBe('object');
  });

  it('una clave inexistente no tiene schema', () => {
    expect(schemaAt('agent.noExiste')).toBeUndefined();
  });

  it('todas las claves del catálogo existen y son editables', () => {
    for (const section of CONFIG_SECTIONS) {
      for (const field of section.fields) {
        const schema = schemaAt(field.key);
        expect(schema, field.key).toBeDefined();
        expect(['complex', 'object'], field.key).not.toContain(fieldKind(schema!).kind);
      }
    }
  });
});

describe('parseFieldInput', () => {
  it('valida contra el schema', () => {
    expect(parseFieldInput('agent.maxIterations', '80')).toEqual({ ok: true, value: 80 });
    expect(parseFieldInput('agent.maxIterations', '-1').ok).toBe(false);
    expect(parseFieldInput('agent.maxIterations', 'mucho').ok).toBe(false);
    expect(parseFieldInput('agent.compressionThreshold', '1.5').ok).toBe(false);
  });

  it('un string se guarda tal cual, aunque parezca un número', () => {
    expect(parseFieldInput('tools.testCommand', '123')).toEqual({ ok: true, value: '123' });
  });

  it('una unión simple coerciona', () => {
    expect(parseFieldInput('tools.auditLog', 'false')).toEqual({ ok: true, value: false });
    expect(parseFieldInput('tools.auditLog', '~/audit.jsonl')).toEqual({
      ok: true,
      value: '~/audit.jsonl',
    });
  });
});

describe('displayValue', () => {
  it('tapa los secretos literales y enseña las variables', () => {
    expect(displayValue('tools.webSearch.tavilyApiKey', 'tvly-123456')).toBe('••••••');
    expect(displayValue('tools.webSearch.tavilyApiKey', '${TAVILY_KEY}')).toBe('${TAVILY_KEY}');
    expect(displayValue('agent.maxIterations', 50)).toBe('50');
  });
});

describe('capas', () => {
  let root: string;
  let globalPath: string;
  let project: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'stratum-editor-'));
    globalPath = join(root, 'home', '.stratum', '.stratumrc.json');
    project = join(root, 'proj');
    mkdirSync(join(root, 'home', '.stratum'), { recursive: true });
    mkdirSync(join(project, '.git'), { recursive: true });
    writeFileSync(
      globalPath,
      JSON.stringify({ agent: { maxIterations: 100 }, box: { enabled: true } }),
    );
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const projectFile = () => join(project, '.stratumrc.json');
  const readJson = (p: string) => JSON.parse(readFileSync(p, 'utf-8')) as Record<string, unknown>;

  it('dice de qué capa sale cada valor', () => {
    writeFileSync(
      projectFile(),
      JSON.stringify({ agent: { maxToolRetries: 5 }, box: { enabled: false } }),
    );
    const layers = readConfigLayers(project, globalPath);

    expect(fieldValue(layers, 'agent.maxToolRetries', 'project')).toMatchObject({
      value: 5,
      origin: 'project',
      inScope: 5,
      inherited: 3,
      inheritedOrigin: 'default',
    });
    expect(fieldValue(layers, 'agent.maxIterations', 'project')).toMatchObject({
      value: 100,
      origin: 'global',
      inScope: undefined,
    });
    expect(fieldValue(layers, 'agent.maxIterations', 'global')).toMatchObject({
      inScope: 100,
      inherited: 50,
    });
    // `box` en un proyecto no cuenta: manda la global.
    expect(fieldValue(layers, 'box.enabled', 'project')).toMatchObject({
      value: true,
      origin: 'global',
    });
  });

  it('escribe en el proyecto (creándolo en la raíz del repo) y quita para heredar', () => {
    const sub = join(project, 'src');
    mkdirSync(sub);
    let layers = readConfigLayers(sub, globalPath);
    expect(layers.projectExists).toBe(false);

    const { path } = writeField(layers, 'project', 'agent.maxIterations', 30);
    expect(path).toBe(projectFile());
    expect(readJson(projectFile())).toEqual({ agent: { maxIterations: 30 } });

    layers = readConfigLayers(sub, globalPath);
    const { backupPath } = writeField(layers, 'project', 'agent.maxIterations', undefined);
    expect(backupPath).toBe(`${projectFile()}.bak`);
    expect(readJson(projectFile())).toEqual({});
  });

  it('una clave solo global no se escribe en un proyecto', () => {
    const layers = readConfigLayers(project, globalPath);
    expect(() => writeField(layers, 'project', 'box.enabled', false)).toThrow(/global/);
    expect(existsSync(projectFile())).toBe(false);
  });

  it('un valor que no valida no toca el disco', () => {
    const layers = readConfigLayers(project, globalPath);
    expect(() => writeField(layers, 'global', 'tui.verbosity', 'enorme')).toThrow();
    expect(readJson(globalPath)).toEqual({ agent: { maxIterations: 100 }, box: { enabled: true } });
  });

  it('en la global escribe la global', () => {
    const layers = readConfigLayers(project, globalPath);
    writeField(layers, 'global', 'tui.verbosity', 'compact');
    expect(readJson(globalPath)['tui']).toEqual({ verbosity: 'compact' });
  });
});
