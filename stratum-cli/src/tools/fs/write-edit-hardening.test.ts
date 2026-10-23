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

describe('edit_file — escalera de match tolerante', () => {
  const at = (p: string) => join(dir, p);
  const write = (p: string, content: string) => writeFileSync(at(p), content, 'utf-8');

  it('nivel 2: comillas tipográficas en el fichero, rectas en old_string', async () => {
    write('q.md', 'El \u201cinforme\u201d y \u2018esto\u2019.\n');
    const r = await editFileTool.execute(
      { path: 'q.md', old_string: 'El "informe"', new_string: 'La "memoria"' },
      ctx,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.output.split('\n')[0]).toBe(
        'File edited: q.md (matched after normalizing unicode punctuation/spaces)',
      );
    }
    // El new_string no se normaliza: las comillas rectas que escribe el modelo quedan.
    expect(text('q.md')).toBe('La "memoria" y \u2018esto\u2019.\n');
  });

  it('nivel 2: comillas rectas en el fichero, tipográficas en old_string', async () => {
    write('q2.md', 'El "informe" importa.\n');
    const r = await editFileTool.execute(
      { path: 'q2.md', old_string: 'El \u201cinforme\u201d', new_string: 'El \u00abinforme\u00bb' },
      ctx,
    );
    expect(r.ok).toBe(true);
    expect(text('q2.md')).toBe('El \u00abinforme\u00bb importa.\n');
  });

  it('nivel 2: guion largo y espacio duro', async () => {
    write('d.md', 'uno \u2014 dos\u00a0tres\n');
    const r = await editFileTool.execute(
      { path: 'd.md', old_string: 'uno - dos tres', new_string: 'uno - dos cuatro' },
      ctx,
    );
    expect(r.ok).toBe(true);
    expect(text('d.md')).toBe('uno - dos cuatro\n');
  });

  it('nivel 3: tab final en la línea', async () => {
    write('t.txt', 'const a = 1;\t\nconst b = 2;\n');
    // El modelo añade espacios al copiar; el fichero tiene un tab. El tramo es
    // la línea entera, así que el tab desaparece con ella.
    const r = await editFileTool.execute(
      { path: 't.txt', old_string: 'const a = 1;  ', new_string: 'const a = 11;' },
      ctx,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.output.split('\n')[0]).toBe(
        'File edited: t.txt (matched ignoring trailing whitespace)',
      );
    }
    expect(text('t.txt')).toBe('const a = 11;\nconst b = 2;\n');
  });

  it('nivel 3: espacios finales en varias líneas, y avisa del nivel', async () => {
    write('m.ts', 'const a = 1;   \nconst b = 2;\t\nconst c = 3;\n');
    const r = await editFileTool.execute(
      {
        path: 'm.ts',
        old_string: 'const a = 1;\nconst b = 2;',
        new_string: 'const a = 10;\nconst b = 20;',
      },
      ctx,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.output.split('\n')[0]).toBe(
        'File edited: m.ts (matched ignoring trailing whitespace)',
      );
      expect(r.output).not.toMatch(/\r/);
    }
    expect(text('m.ts')).toBe('const a = 10;\nconst b = 20;\nconst c = 3;\n');
  });

  it('nivel 3 sobre CRLF: deja el fichero en CRLF', async () => {
    write('c.ts', 'const a = 1;  \r\nconst b = 2; \r\nconst c = 3;\r\n');
    const r = await editFileTool.execute(
      {
        path: 'c.ts',
        old_string: 'const a = 1;\nconst b = 2;',
        new_string: 'const a = 10;\nconst b = 20;',
      },
      ctx,
    );
    expect(r.ok).toBe(true);
    expect(text('c.ts')).toBe('const a = 10;\r\nconst b = 20;\r\nconst c = 3;\r\n');
    if (r.ok) expect(r.output).not.toMatch(/\r/);
  });

  it('nivel 3: con y sin salto final en old_string no duplica ni pierde el salto', async () => {
    write('n1.txt', 'one  \ntwo \nend\n');
    const noNewline = await editFileTool.execute(
      { path: 'n1.txt', old_string: 'one\ntwo', new_string: 'ONE\nTWO' },
      ctx,
    );
    expect(noNewline.ok).toBe(true);
    expect(text('n1.txt')).toBe('ONE\nTWO\nend\n');

    write('n2.txt', 'one  \ntwo \nend\n');
    const withNewline = await editFileTool.execute(
      { path: 'n2.txt', old_string: 'one\ntwo\n', new_string: 'ONE\nTWO\n' },
      ctx,
    );
    expect(withNewline.ok).toBe(true);
    expect(text('n2.txt')).toBe('ONE\nTWO\nend\n');
  });

  it('nivel 2 conserva el BOM', async () => {
    writeFileSync(at('b.cs'), Buffer.from('\ufeffvar s = \u2018hola\u2019;\n', 'utf-8'));
    const r = await editFileTool.execute(
      { path: 'b.cs', old_string: "var s = 'hola';", new_string: "var s = 'adios';" },
      ctx,
    );
    expect(r.ok).toBe(true);
    expect([...bytes('b.cs').subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(text('b.cs')).toBe("\ufeffvar s = 'adios';\n");
  });

  it('nivel 2 ambiguo sin replace_all → error recuperable que nombra el nivel', async () => {
    const original = 'a = \u2018x\u2019;\nb = \u2018x\u2019;\n';
    write('amb.txt', original);
    const r = await editFileTool.execute(
      { path: 'amb.txt', old_string: "'x'", new_string: "'y'" },
      ctx,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.recoverable).toBe(true);
      expect(r.error).toContain('appears 2 times');
      expect(r.error).toContain('after normalizing unicode punctuation/spaces');
    }
    expect(text('amb.txt')).toBe(original);
  });

  it('nivel 2 con replace_all reemplaza todas', async () => {
    write('all.txt', 'a = \u2018x\u2019;\nb = \u2018x\u2019;\n');
    const r = await editFileTool.execute(
      { path: 'all.txt', old_string: "'x'", new_string: "'y'", replace_all: true },
      ctx,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.output.split('\n')[0]).toBe(
        'File edited: all.txt (matched after normalizing unicode punctuation/spaces) (2 occurrences replaced)',
      );
    }
    expect(text('all.txt')).toBe("a = 'y';\nb = 'y';\n");
  });

  it('nivel 2: $& y $$ del new_string salen literales', async () => {
    write('dollar.sh', 'echo \u2018X\u2019\n');
    const r = await editFileTool.execute(
      { path: 'dollar.sh', old_string: "'X'", new_string: 'price=$$ match=$& grp=$1' },
      ctx,
    );
    expect(r.ok).toBe(true);
    expect(text('dollar.sh')).toBe('echo price=$$ match=$& grp=$1\n');
  });

  it('el nivel exacto gana aunque el unicode casase más veces', async () => {
    write('win.txt', "const x = \u2018a\u2019;\nconst y = 'a';\n");
    const r = await editFileTool.execute(
      { path: 'win.txt', old_string: "'a'", new_string: "'b'" },
      ctx,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.output.split('\n')[0]).toBe('File edited: win.txt');
      expect(r.output).not.toContain('matched');
    }
    // Solo cambia la aparición recta: la tipográfica ni se toca.
    expect(text('win.txt')).toBe("const x = \u2018a\u2019;\nconst y = 'b';\n");
  });

  it('nivel 2 sobre CRLF: casa un old_string con \\n y deja CRLF', async () => {
    // Fichero CRLF con comillas tipográficas: el nivel exacto falla (ni las
    // comillas ni los `\\r` casan) y el unicode tiene que ignorar el `\\r`.
    write('q3.ts', 'const a = \u2018x\u2019;\r\nconst b = 2;\r\nconst c = 3;\r\n');
    const r = await editFileTool.execute(
      {
        path: 'q3.ts',
        old_string: "const a = 'x';\nconst b = 2;",
        new_string: "const a = 'y';\nconst b = 20;",
      },
      ctx,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.output.split('\n')[0]).toBe(
        'File edited: q3.ts (matched after normalizing unicode punctuation/spaces)',
      );
      expect(r.output).not.toMatch(/\r/);
    }
    expect(text('q3.ts')).toBe("const a = 'y';\r\nconst b = 20;\r\nconst c = 3;\r\n");
  });

  it('un old_string con BOM inicial se acepta', async () => {
    write('bom.ts', 'const a = 1;\n');
    const r = await editFileTool.execute(
      { path: 'bom.ts', old_string: '\ufeffconst a = 1;', new_string: 'const a = 2;' },
      ctx,
    );
    expect(r.ok).toBe(true);
    expect(text('bom.ts')).toBe('const a = 2;\n');
  });

  it('un old_string que solo son espacios no casa en ningún nivel', async () => {
    const original = 'a  \nb\n';
    write('ws.txt', original);
    const r = await editFileTool.execute(
      { path: 'ws.txt', old_string: '   ', new_string: 'X' },
      ctx,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.recoverable).toBe(true);
      expect(r.error).toContain('even after normalizing');
    }
    expect(text('ws.txt')).toBe(original);
  });

  it('el "not found" menciona que ya se probó la normalización', async () => {
    write('nf.txt', 'hola\n');
    const r = await editFileTool.execute(
      { path: 'nf.txt', old_string: 'adios', new_string: 'X' },
      ctx,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('even after normalizing');
  });
});

describe('edit_file / write_file — diagnósticos LSP (UX-2b)', () => {
  type Diagnose = NonNullable<ToolContext['diagnostics']>['diagnose'];
  const withDiagnostics = (diagnose: Diagnose): ToolContext => ({
    ...ctx,
    diagnostics: { diagnose },
  });

  it('edit_file anexa el texto del provider tras una edición correcta', async () => {
    writeFileSync(join(dir, 'a.ts'), 'const a = 1;\n');
    const calls: { absPath: string; text: string; signal?: AbortSignal }[] = [];
    const report = 'Diagnostics (typescript) for a.ts — 1 error:\n  1:7  error  TS1  roto';
    const r = await editFileTool.execute(
      { path: 'a.ts', old_string: '1', new_string: '2' },
      withDiagnostics(async (absPath, text, signal) => {
        calls.push({ absPath, text, signal });
        return report;
      }),
    );

    expect(r.ok).toBe(true);
    if (r.ok) {
      // Texto tal cual, separado del resultado por una línea en blanco.
      expect(r.output.endsWith(`\n\n${report}`)).toBe(true);
      expect(r.output).toMatch(/^File edited: a\.ts/);
    }
    expect(calls).toHaveLength(1);
    expect(calls[0]!.absPath).toBe(join(dir, 'a.ts'));
    expect(calls[0]!.text).toBe('const a = 2;\n');
    // El AbortSignal del turno se propaga.
    expect(calls[0]!.signal).toBe(ctx.signal);
  });

  it('un diagnose que lanza no rompe la edición', async () => {
    writeFileSync(join(dir, 'b.ts'), 'const a = 1;\n');
    const r = await editFileTool.execute(
      { path: 'b.ts', old_string: '1', new_string: '2' },
      withDiagnostics(async () => {
        throw new Error('el language server murió');
      }),
    );

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.output).toContain('File edited: b.ts');
      expect(r.output).not.toContain('Diagnostics');
    }
    expect(text('b.ts')).toBe('const a = 2;\n');
  });

  it('null o cadena vacía dejan el resultado exactamente como estaba', async () => {
    writeFileSync(join(dir, 'c.ts'), 'const a = 1;\n');
    const plain = await editFileTool.execute(
      { path: 'c.ts', old_string: '1', new_string: '2' },
      ctx,
    );
    writeFileSync(join(dir, 'c.ts'), 'const a = 1;\n');
    const nulled = await editFileTool.execute(
      { path: 'c.ts', old_string: '1', new_string: '2' },
      withDiagnostics(async () => null),
    );
    writeFileSync(join(dir, 'c.ts'), 'const a = 1;\n');
    const halfEmpty = await editFileTool.execute(
      { path: 'c.ts', old_string: '1', new_string: '2' },
      withDiagnostics(async () => '   '),
    );

    expect(plain.ok && nulled.ok && halfEmpty.ok).toBe(true);
    if (plain.ok && nulled.ok && halfEmpty.ok) {
      expect(nulled.output).toBe(plain.output);
      expect(halfEmpty.output).toBe(plain.output);
    }
  });

  it('write_file también anexa los diagnósticos del fichero escrito', async () => {
    const calls: { absPath: string; text: string }[] = [];
    const r = await writeFileTool.execute(
      { path: 'd.ts', content: 'const x = ERROR;\n' },
      withDiagnostics(async (absPath, content) => {
        calls.push({ absPath, text: content });
        return 'Diagnostics (typescript) for d.ts — 1 error:\n  1:11  error  FAKE1  bad line';
      }),
    );

    expect(r.ok).toBe(true);
    if (r.ok)
      expect(
        r.output.endsWith(
          '\n\nDiagnostics (typescript) for d.ts — 1 error:\n  1:11  error  FAKE1  bad line',
        ),
      ).toBe(true);
    expect(calls).toEqual([{ absPath: join(dir, 'd.ts'), text: 'const x = ERROR;\n' }]);
    expect(text('d.ts')).toBe('const x = ERROR;\n');
  });

  it('sin ctx.diagnostics no se llama nada y el resultado no cambia', async () => {
    writeFileSync(join(dir, 'e.ts'), 'const a = 1;\n');
    const r = await editFileTool.execute({ path: 'e.ts', old_string: '1', new_string: '2' }, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.output).not.toContain('Diagnostics');
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
