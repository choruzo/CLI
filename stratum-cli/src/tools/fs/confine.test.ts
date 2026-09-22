import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, readFileSync, symlinkSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { ToolContext, ToolDefinition, WorkspaceConfinement } from '../../agent/types.js';
import { StratumConfigSchema } from '../../config/schema.js';
import { ToolDispatcher, ToolRegistry } from '../registry.js';
import { confinePath } from './confine.js';
import { readFileTool } from './read.js';
import { writeFileTool } from './write.js';
import { editFileTool } from './edit.js';
import { globTool } from './glob.js';
import { grepTool } from './grep.js';
import { listDirectoryTool } from './list.js';

const config = StratumConfigSchema.parse({});
const IS_WINDOWS = process.platform === 'win32';

let base: string;
let root: string;
let outside: string;
let ws: WorkspaceConfinement;

/** `null` = sin workspace, como en la CLI. */
function ctxFor(workspace: WorkspaceConfinement | null = ws): ToolContext {
  return {
    signal: new AbortController().signal,
    cwd: workspace?.root ?? process.cwd(),
    config,
    workspace: workspace ?? undefined,
  };
}

/** Enlace a un directorio: junction en Windows (no exige privilegios), symlink en POSIX. */
function linkDir(target: string, path: string): void {
  symlinkSync(target, path, IS_WINDOWS ? 'junction' : 'dir');
}

/** Symlink de fichero; en Windows sin modo desarrollador no se puede crear → `false`. */
function tryLinkFile(target: string, path: string): boolean {
  try {
    symlinkSync(target, path, 'file');
    return true;
  } catch {
    return false;
  }
}

beforeEach(() => {
  base = join(tmpdir(), `stratum-confine-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  root = join(base, 'ws');
  outside = join(base, 'outside');
  for (const dir of ['inputs', 'outputs', 'scratch'])
    mkdirSync(join(root, dir), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(root, 'inputs', 'datos.csv'), 'a,b\n1,2\n');
  writeFileSync(join(root, '.workspace.json'), '{}');
  writeFileSync(join(outside, 'secreto.txt'), 'SECRETO-FUERA');
  ws = { root, readOnly: ['inputs'], writable: ['outputs', 'scratch'] };
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('confinePath', () => {
  it('resuelve rutas relativas contra la raíz', () => {
    const r = confinePath(ws, 'inputs/datos.csv', 'read');
    expect(r).toMatchObject({ ok: true, relative: 'inputs/datos.csv' });
  });

  it('veta `..` encadenados, también los que vuelven a entrar tras salir', () => {
    expect(confinePath(ws, '../outside/secreto.txt', 'read').ok).toBe(false);
    expect(confinePath(ws, 'inputs/../../outside/secreto.txt', 'read').ok).toBe(false);
    expect(confinePath(ws, 'a/b/../../../../', 'read').ok).toBe(false);
    // Sale y vuelve a entrar: el resultado está dentro y se permite.
    expect(confinePath(ws, '../ws/inputs/datos.csv', 'read').ok).toBe(true);
  });

  it('veta una ruta absoluta de fuera y admite una absoluta de dentro', () => {
    expect(confinePath(ws, join(outside, 'secreto.txt'), 'read').ok).toBe(false);
    expect(confinePath(ws, join(root, 'inputs', 'datos.csv'), 'read').ok).toBe(true);
  });

  it('veta un directorio enlazado (symlink/junction) que apunta fuera', () => {
    linkDir(outside, join(root, 'scratch', 'fuga'));
    expect(confinePath(ws, 'scratch/fuga/secreto.txt', 'read').ok).toBe(false);
    // Tampoco se puede escribir a través de él un fichero nuevo.
    expect(confinePath(ws, 'scratch/fuga/nuevo.txt', 'write').ok).toBe(false);
  });

  it('veta un symlink de fichero que apunta fuera', () => {
    if (!tryLinkFile(join(outside, 'secreto.txt'), join(root, 'scratch', 'link.txt'))) return;
    expect(confinePath(ws, 'scratch/link.txt', 'read').ok).toBe(false);
  });

  it('veta un symlink roto: escribir a través de él crearía el fichero fuera', () => {
    const target = join(outside, 'creado-fuera.txt');
    if (!tryLinkFile(target, join(root, 'outputs', 'roto.txt'))) return;
    expect(confinePath(ws, 'outputs/roto.txt', 'write').ok).toBe(false);
  });

  it('inputs/ es de solo lectura; la raíz y sus ficheros sueltos no se escriben', () => {
    expect(confinePath(ws, 'inputs/datos.csv', 'write')).toMatchObject({ ok: false });
    expect(confinePath(ws, 'inputs/nuevo.txt', 'write')).toMatchObject({ ok: false });
    expect(confinePath(ws, '.workspace.json', 'write')).toMatchObject({ ok: false });
    expect(confinePath(ws, 'suelto.txt', 'write')).toMatchObject({ ok: false });
    expect(confinePath(ws, '.', 'write')).toMatchObject({ ok: false });
    expect(confinePath(ws, 'otra/cosa.txt', 'write')).toMatchObject({ ok: false });
    expect(confinePath(ws, 'outputs/informe.md', 'write')).toMatchObject({ ok: true });
    expect(confinePath(ws, 'scratch/a/b/c.txt', 'write')).toMatchObject({ ok: true });
  });

  it('en Windows, inputs/ es de solo lectura también con otras mayúsculas', () => {
    if (!IS_WINDOWS) return;
    expect(confinePath(ws, 'INPUTS/datos.csv', 'write').ok).toBe(false);
  });

  it('veta bytes NUL', () => {
    expect(confinePath(ws, 'outputs/a\0.txt', 'write').ok).toBe(false);
  });

  it('en Windows veta UNC, dispositivos, rutas relativas a unidad y flujos alternativos', () => {
    if (!IS_WINDOWS) return;
    for (const p of [
      '\\\\server\\share\\x.txt',
      '\\\\?\\C:\\Windows\\win.ini',
      '\\\\.\\pipe\\algo',
      '//server/share/x',
      'C:secreto.txt',
      'outputs/informe.txt:oculto',
      'outputs/CON',
      'outputs/nul.txt',
      'outputs/COM1. ',
    ]) {
      expect(confinePath(ws, p, 'write').ok, p).toBe(false);
    }
  });

  it('falla cerrado: una raíz que no existe veta, no lanza', () => {
    const r = confinePath({ root: join(base, 'no-existe') }, 'x.txt', 'read');
    expect(r.ok).toBe(false);
  });
});

describe('tools de fichero con workspace', () => {
  it('read_file lee rutas relativas a la raíz y veta las de fuera', async () => {
    const ok = await readFileTool.execute({ path: 'inputs/datos.csv' }, ctxFor());
    expect(ok).toMatchObject({ ok: true });
    const veto = readFileTool.preflight!({ path: '../outside/secreto.txt' }, ctxFor());
    expect(veto).toMatchObject({ ok: false });
    // Defensa en profundidad: `execute` también lo comprueba.
    const direct = await readFileTool.execute({ path: '../outside/secreto.txt' }, ctxFor());
    expect(direct.ok).toBe(false);
    expect(JSON.stringify(direct)).not.toContain('SECRETO-FUERA');
  });

  it('write_file escribe en outputs/ y no en inputs/', async () => {
    const ok = await writeFileTool.execute(
      { path: 'outputs/resumen.md', content: '# hola' },
      ctxFor(),
    );
    expect(ok.ok).toBe(true);
    expect(readFileSync(join(root, 'outputs', 'resumen.md'), 'utf-8')).toBe('# hola');
    const veto = await writeFileTool.execute(
      { path: 'inputs/datos.csv', content: 'pisado' },
      ctxFor(),
    );
    expect(veto.ok).toBe(false);
    expect(readFileSync(join(root, 'inputs', 'datos.csv'), 'utf-8')).toBe('a,b\n1,2\n');
  });

  it('edit_file no toca el original subido', async () => {
    const r = await editFileTool.execute(
      { path: 'inputs/datos.csv', old_string: '1,2', new_string: '9,9' },
      ctxFor(),
    );
    expect(r.ok).toBe(false);
    expect(readFileSync(join(root, 'inputs', 'datos.csv'), 'utf-8')).toBe('a,b\n1,2\n');
  });

  it('glob, grep y list_directory vetan una base fuera y no siguen enlaces', async () => {
    linkDir(outside, join(root, 'scratch', 'fuga'));
    for (const [tool, params] of [
      [globTool, { pattern: '**/*', cwd: '..' }],
      [grepTool, { pattern: 'SECRETO', cwd: outside }],
      [listDirectoryTool, { path: '../outside' }],
    ] as [ToolDefinition, Record<string, unknown>][]) {
      expect(tool.preflight!(params, ctxFor()), tool.name).toMatchObject({ ok: false });
    }
    const globbed = await globTool.execute({ pattern: '**/*.txt' }, ctxFor());
    expect(globbed).toMatchObject({ ok: true });
    expect((globbed as { output: string }).output).not.toContain('secreto');
    const grepped = await grepTool.execute({ pattern: 'SECRETO-FUERA' }, ctxFor());
    expect(grepped).toEqual({ ok: true, output: '(no matches)' });
    const listed = await listDirectoryTool.execute({ path: '.', depth: 3 }, ctxFor());
    expect((listed as { output: string }).output).not.toContain('secreto');
  });

  it('el veto no se levanta con política allow ni allow-all', async () => {
    const registry = new ToolRegistry();
    registry.register(readFileTool);
    registry.register(writeFileTool);
    const dispatcher = new ToolDispatcher(registry, 3);
    let asked = 0;
    const results = await dispatcher.dispatch(
      [
        { id: 'c1', name: 'read_file', input: { path: join(outside, 'secreto.txt') } },
        { id: 'c2', name: 'write_file', input: { path: '../outside/x.txt', content: 'x' } },
      ],
      {
        ...ctxFor(),
        allowDestructive: true,
        destructivePolicy: 'allow',
        confirmDestructive: async () => {
          asked++;
          return 'allow-all';
        },
      },
    );
    expect(results.map((r) => r.result.ok)).toEqual([false, false]);
    expect(asked).toBe(0);
    expect(existsSync(join(outside, 'x.txt'))).toBe(false);
    expect(JSON.stringify(results)).not.toContain('SECRETO-FUERA');
  });

  it('sin workspace (la CLI) nada cambia: rutas absolutas en cualquier sitio', async () => {
    const r = await readFileTool.execute({ path: join(outside, 'secreto.txt') }, ctxFor(null));
    expect(r).toMatchObject({ ok: true });
  });
});
