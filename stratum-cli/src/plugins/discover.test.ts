import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { discoverPlugins, resolveFolderEntry, type DiscoverOptions } from './discover.js';
import { loadPlugins } from './index.js';
import { validatePluginExport } from './load-module.js';
import { PLUGIN_API_VERSION } from './api.js';
import { StratumConfigSchema } from '../config/schema.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'guard-env.mjs');
const PLUGIN_SRC = (id: string) =>
  `export default { id: '${id}', apiVersion: 1, setup(api) { api.on('tool.before', () => undefined); } };\n`;

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'stratum-plugins-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function opts(over: Partial<DiscoverOptions> = {}): DiscoverOptions {
  return {
    flagPaths: [],
    globalEntries: {},
    globalConfigDir: root,
    pluginsDir: null,
    projectOnlyIds: [],
    cwd: root,
    typescript: true,
    ...over,
  };
}

describe('discoverPlugins', () => {
  it('orden: --plugin, config global, directorio (alfabético); sin importar nada', () => {
    const dir = join(root, 'plugins');
    mkdirSync(join(dir, 'b-folder'), { recursive: true });
    writeFileSync(join(dir, 'b-folder', 'index.js'), PLUGIN_SRC('b-folder'));
    writeFileSync(join(dir, 'a.mjs'), PLUGIN_SRC('a'));
    writeFileSync(join(dir, 'notas.txt'), 'no es un plugin');
    mkdirSync(join(dir, '.oculto'));
    writeFileSync(join(root, 'flag.js'), PLUGIN_SRC('flag'));
    writeFileSync(join(root, 'cfg.js'), PLUGIN_SRC('cfg'));
    const d = discoverPlugins(
      opts({
        flagPaths: ['flag.js'],
        globalEntries: { cfg: { path: 'cfg.js', options: { x: 1 } } },
        pluginsDir: dir,
      }),
    );
    expect(d.candidates.map((c) => [c.source, c.expectedId])).toEqual([
      ['flag', undefined],
      ['config', 'cfg'],
      ['directory', 'a'],
      ['directory', 'b-folder'],
    ]);
    expect(d.candidates[1]!.options).toEqual({ x: 1 });
    expect(d.skipped).toEqual([]);
  });

  it('`enabled: false` apaga uno del directorio sin importarlo; `--plugin` no se apaga', () => {
    const dir = join(root, 'plugins');
    mkdirSync(dir);
    writeFileSync(join(dir, 'viejo.js'), PLUGIN_SRC('viejo'));
    const d = discoverPlugins(
      opts({
        globalEntries: { viejo: { enabled: false } },
        pluginsDir: dir,
        flagPaths: [join(dir, 'viejo.js')],
      }),
    );
    expect(d.candidates.map((c) => c.source)).toEqual(['flag']);
    expect(d.skipped).toEqual([
      expect.objectContaining({
        source: 'directory',
        id: 'viejo',
        reason: 'desactivado en la config',
      }),
    ]);
  });

  it('paquete sin instalar, entrada sin path y plugins de proyecto: omitidos con motivo', () => {
    const d = discoverPlugins(
      opts({
        globalEntries: { jira: { package: 'stratum-plugin-jira@1.2.0' }, vacio: {} },
        projectOnlyIds: ['del-repo'],
      }),
    );
    expect(d.candidates).toEqual([]);
    expect(d.skipped.map((s) => [s.source, s.id])).toEqual([
      ['config', 'jira'],
      ['config', 'vacio'],
      ['project', 'del-repo'],
    ]);
    expect(d.skipped[2]!.reason).toMatch(/confianza de proyecto/);
  });

  it('un .ts en un Node que no quita tipos se rechaza con el motivo', () => {
    writeFileSync(join(root, 'p.ts'), PLUGIN_SRC('p'));
    const d = discoverPlugins(opts({ flagPaths: ['p.ts'], typescript: false }));
    expect(d.candidates).toEqual([]);
    expect(d.skipped[0]!.reason).toMatch(/Node ≥ 22\.18/);
  });

  it('un entry que sale de la carpeta del plugin (symlink) se rechaza', () => {
    const outside = join(root, 'fuera.js');
    writeFileSync(outside, PLUGIN_SRC('fuera'));
    const folder = join(root, 'plug');
    mkdirSync(folder);
    try {
      symlinkSync(outside, join(folder, 'index.js'));
    } catch {
      return; // sin permiso para crear symlinks (Windows sin modo desarrollador)
    }
    expect(resolveFolderEntry(folder)).toEqual({
      reason: expect.stringMatching(/sale de la carpeta/),
    });
  });

  it('package.json: `stratum.plugin` manda sobre `main`', () => {
    const folder = join(root, 'pkg');
    mkdirSync(folder);
    writeFileSync(join(folder, 'entry.js'), PLUGIN_SRC('pkg'));
    writeFileSync(join(folder, 'main.js'), PLUGIN_SRC('pkg'));
    writeFileSync(
      join(folder, 'package.json'),
      JSON.stringify({ main: 'main.js', stratum: { plugin: './entry.js' } }),
    );
    const res = resolveFolderEntry(folder);
    expect('entry' in res && res.entry.endsWith('entry.js')).toBe(true);
  });
});

describe('validatePluginExport', () => {
  it('rechaza una API más nueva que la del host', () => {
    const res = validatePluginExport({ id: 'x', apiVersion: PLUGIN_API_VERSION + 1, setup() {} });
    expect(res).toEqual({ ok: false, reason: expect.stringMatching(/actualiza Stratum/) });
  });

  it('rechaza un id con mayúsculas y un export sin setup', () => {
    expect(validatePluginExport({ id: 'Malo', apiVersion: 1, setup() {} }).ok).toBe(false);
    expect(validatePluginExport({ id: 'x', apiVersion: 1 }).ok).toBe(false);
    expect(validatePluginExport(undefined).ok).toBe(false);
  });
});

describe('loadPlugins', () => {
  const config = StratumConfigSchema.parse({});
  const noGlobal = () => join(root, 'no-existe.json');

  it('carga un plugin real con import() y le pasa sus opciones', async () => {
    const globalPath = join(root, '.stratumrc.json');
    writeFileSync(
      globalPath,
      JSON.stringify({
        plugins: { entries: { 'guard-env': { path: FIXTURE, options: { tag: 'T' } } } },
      }),
    );
    const host = await loadPlugins({
      cwd: root,
      config,
      globalConfigPath: globalPath,
      pluginsDir: null,
    });
    expect(host.report().loaded).toEqual([
      expect.objectContaining({
        id: 'guard-env',
        source: 'config',
        hooks: { 'tool.before': 1, 'tool.after': 1 },
      }),
    ]);
    const vetoes = await host.vetoBatch(
      [
        {
          callId: 'c',
          tool: 'exec',
          input: { command: 'terraform destroy -auto-approve' },
          agent: { kind: 'main' },
        },
      ],
      new AbortController().signal,
    );
    expect(vetoes.get('c')?.reason).toMatch(/terraform destroy is not allowed/);
    const after = await host.afterTool(
      {
        tool: 'probe',
        input: {},
        callId: 'd',
        agent: { kind: 'main' },
        ok: true,
        output: 'x',
        durationMs: 1,
      },
      new AbortController().signal,
    );
    expect(after).toBe('x\n[T]');
    await host.dispose();
  });

  it('el id del módulo tiene que ser el de la config; un id repetido se omite', async () => {
    const globalPath = join(root, '.stratumrc.json');
    writeFileSync(
      globalPath,
      JSON.stringify({ plugins: { entries: { otro: { path: FIXTURE } } } }),
    );
    const host = await loadPlugins({
      cwd: root,
      config,
      globalConfigPath: globalPath,
      pluginsDir: null,
      paths: [FIXTURE, FIXTURE],
    });
    const report = host.report();
    expect(report.loaded.map((p) => p.id)).toEqual(['guard-env']);
    expect(report.skipped).toEqual([
      expect.objectContaining({
        id: 'guard-env',
        reason: expect.stringMatching(/la config lo declara como "otro"/),
      }),
    ]);
  });

  it('--no-plugins y plugins.enabled: false no cargan nada, tampoco --plugin', async () => {
    const off = await loadPlugins({
      cwd: root,
      config,
      disabled: true,
      paths: [FIXTURE],
      globalConfigPath: noGlobal(),
    });
    expect(off.report()).toMatchObject({ enabled: false, loaded: [] });
    const globalPath = join(root, '.stratumrc.json');
    writeFileSync(globalPath, JSON.stringify({ plugins: { enabled: false } }));
    const off2 = await loadPlugins({
      cwd: root,
      config,
      paths: [FIXTURE],
      globalConfigPath: globalPath,
    });
    expect(off2.report()).toMatchObject({ enabled: false, loaded: [] });
  });

  it('un plugin roto queda en el informe y no impide cargar los demás', async () => {
    const broken = join(root, 'roto.mjs');
    writeFileSync(
      broken,
      'export default { id: "roto", apiVersion: 1, setup() { throw new Error("x"); } };',
    );
    const syntax = join(root, 'sintaxis.mjs');
    writeFileSync(syntax, 'export default {');
    const host = await loadPlugins({
      cwd: root,
      config,
      globalConfigPath: noGlobal(),
      pluginsDir: null,
      paths: [broken, syntax, FIXTURE],
    });
    const report = host.report();
    expect(report.loaded.map((p) => p.id)).toEqual(['guard-env']);
    expect(report.skipped.map((s) => s.reason)).toEqual([
      expect.stringMatching(/setup falló: x/),
      expect.stringMatching(/no se pudo importar/),
    ]);
  });

  it('la config de proyecto no carga plugins: solo cuenta la global', async () => {
    const projectConfig = StratumConfigSchema.parse({
      plugins: { entries: { 'del-repo': { path: FIXTURE } } },
    });
    const host = await loadPlugins({
      cwd: root,
      config: projectConfig,
      globalConfigPath: noGlobal(),
      pluginsDir: null,
    });
    expect(host.report().loaded).toEqual([]);
    expect(host.report().skipped).toEqual([
      expect.objectContaining({ source: 'project', id: 'del-repo' }),
    ]);
  });
});
