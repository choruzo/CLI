import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { editFileTool } from './edit.js';
import { writeFileTool } from './write.js';
import { readFileTool } from './read.js';
import { FileStateTracker } from './file-state.js';
import type { ToolContext } from '../../agent/types.js';
import { StratumConfigSchema } from '../../config/schema.js';

const config = StratumConfigSchema.parse({});
let dir: string;
let ctx: ToolContext;

beforeEach(() => {
  dir = join(tmpdir(), `stratum-wedit-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  ctx = {
    signal: new AbortController().signal,
    cwd: dir,
    config,
    fileState: new FileStateTracker(),
  };
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const bytes = (p: string) => readFileSync(join(dir, p));
const text = (p: string) => readFileSync(join(dir, p), 'utf-8');

describe('edit_file endurecido', () => {
  it('inserta $&, $$ y $1 literalmente', async () => {
    writeFileSync(join(dir, 'a.sh'), 'echo X\n');
    const r = await editFileTool.execute(
      { path: 'a.sh', old_string: 'X', new_string: 'price=$$ match=$& grp=$1' },
      ctx,
    );
    expect(r.ok).toBe(true);
    expect(text('a.sh')).toBe('echo price=$$ match=$& grp=$1\n');
  });

  it('casa un old_string LF de varias líneas en un fichero CRLF y lo deja CRLF', async () => {
    writeFileSync(join(dir, 'w.ts'), 'const a = 1;\r\nconst b = 2;\r\nconst c = 3;\r\n');
    const r = await editFileTool.execute(
      {
        path: 'w.ts',
        old_string: 'const a = 1;\nconst b = 2;',
        new_string: 'const a = 10;\nconst b = 20;\nconst extra = 0;',
      },
      ctx,
    );
    expect(r.ok).toBe(true);
    expect(text('w.ts')).toBe(
      'const a = 10;\r\nconst b = 20;\r\nconst extra = 0;\r\nconst c = 3;\r\n',
    );
    if (r.ok) expect(r.output).not.toContain('\r');
  });

  it('conserva el BOM', async () => {
    writeFileSync(join(dir, 'b.cs'), Buffer.from('﻿class A {}\n', 'utf-8'));
    const r = await editFileTool.execute(
      { path: 'b.cs', old_string: 'class A', new_string: 'class B' },
      ctx,
    );
    expect(r.ok).toBe(true);
    expect([...bytes('b.cs').subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(text('b.cs')).toBe('﻿class B {}\n');
  });

  it('rechaza un fichero Latin-1 sin tocar un byte', async () => {
    const original = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x20, 0x58, 0x0a]); // "café X\n"
    writeFileSync(join(dir, 'l1.txt'), original);
    const r = await editFileTool.execute({ path: 'l1.txt', old_string: 'X', new_string: 'Y' }, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/not valid UTF-8/);
    expect(bytes('l1.txt').equals(original)).toBe(true);
  });
});

describe('write_file endurecido', () => {
  it('al sobrescribir conserva CRLF y BOM del original', async () => {
    writeFileSync(join(dir, 'c.txt'), Buffer.from('﻿uno\r\ndos\r\n', 'utf-8'));
    const r = await writeFileTool.execute({ path: 'c.txt', content: 'tres\ncuatro\n' }, ctx);
    expect(r.ok).toBe(true);
    expect(text('c.txt')).toBe('﻿tres\r\ncuatro\r\n');
  });

  it('un fichero nuevo se escribe tal cual', async () => {
    const r = await writeFileTool.execute({ path: 'n.txt', content: 'a\nb\n' }, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.output).toMatch(/created/);
    expect(text('n.txt')).toBe('a\nb\n');
  });

  it('se niega a sobrescribir un fichero que cambió desde que el agente lo leyó', async () => {
    writeFileSync(join(dir, 'd.txt'), 'v1\n');
    await readFileTool.execute({ path: 'd.txt' }, ctx);
    writeFileSync(join(dir, 'd.txt'), 'v2 del usuario, más largo\n');

    const r = await writeFileTool.execute({ path: 'd.txt', content: 'del agente\n' }, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.recoverable).toBe(true);
      expect(r.error).toMatch(/changed on disk since you last read it/);
    }
    expect(text('d.txt')).toBe('v2 del usuario, más largo\n');

    // Tras releer, sí.
    await readFileTool.execute({ path: 'd.txt' }, ctx);
    const again = await writeFileTool.execute({ path: 'd.txt', content: 'del agente\n' }, ctx);
    expect(again.ok).toBe(true);
    expect(text('d.txt')).toBe('del agente\n');
  });

  it('sus propias escrituras cuentan como versión vista', async () => {
    await writeFileTool.execute({ path: 'e.txt', content: 'uno\n' }, ctx);
    const edit = await editFileTool.execute(
      { path: 'e.txt', old_string: 'uno', new_string: 'dos' },
      ctx,
    );
    expect(edit.ok).toBe(true);
    const w = await writeFileTool.execute({ path: 'e.txt', content: 'tres\n' }, ctx);
    expect(w.ok).toBe(true);
  });

  it('un fichero nunca leído no se comprueba', async () => {
    writeFileSync(join(dir, 'f.txt'), 'existente\n');
    const r = await writeFileTool.execute({ path: 'f.txt', content: 'nuevo\n' }, ctx);
    expect(r.ok).toBe(true);
  });
});

describe('read_file', () => {
  it('no enseña los \\r de CRLF ni el BOM', async () => {
    writeFileSync(join(dir, 'g.txt'), Buffer.from('﻿a\r\nb\r\n', 'utf-8'));
    const r = await readFileTool.execute({ path: 'g.txt' }, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.output).not.toContain('\r');
      expect(r.output.startsWith('1: a\n2: b')).toBe(true);
    }
  });
});
