import { describe, it, expect } from 'vitest';
import {
  toolIntent,
  diffStats,
  diffLines,
  diffTrailer,
  execSummary,
  cardLabel,
  cardSummary,
} from './tool-card.js';
import type { ToolCallState } from './ToolCallBlock.js';

const completed = (name: string, input: Record<string, unknown>, output: string): ToolCallState => ({
  id: '1',
  name,
  status: 'completed',
  input,
  output,
});

// Salida real de `edit_file` en una edición sencilla.
const SIMPLE_EDIT = [
  'File edited: src/a.ts',
  '',
  '--- src/a.ts',
  '+++ src/a.ts',
  '@@ -1,3 +1,3 @@',
  ' const a = 1;',
  '-const b = 2;',
  '+const b = 3;',
  ' const c = 4;',
].join('\n');

const EDIT_WITH_LSP = `${SIMPLE_EDIT}\n\n${[
  'Diagnósticos LSP de src/a.ts:',
  '- error TS2345 en línea 1',
  '+ sugerencia: revisar el tipo',
].join('\n')}`;

// El dispatcher corta cabeza + marcador + cola: el diff puede quedar a medias.
const TRUNCATED_EDIT = [
  'File edited: src/a.ts',
  '',
  '--- src/a.ts',
  '+++ src/a.ts',
  '@@ -1,3 +1,3 @@',
  ' const a = 1;',
  '-const b = 2;',
  '+const b = 3;',
  '',
  '[... output truncated (16 chars total) ...]',
].join('\n');

describe('toolIntent', () => {
  it('clasifica terminal, diff, familias y other', () => {
    expect(toolIntent('exec')).toBe('terminal');
    expect(toolIntent('ssh_exec')).toBe('terminal');
    expect(toolIntent('edit_file')).toBe('diff');
    expect(toolIntent('write_file')).toBe('diff');
    expect(toolIntent('read_file')).toBe('read');
    expect(toolIntent('grep')).toBe('search');
    expect(toolIntent('web_fetch')).toBe('web');
    expect(toolIntent('store_decision')).toBe('other');
  });
});

describe('diffStats', () => {
  it('cuenta una edición sencilla (+1 −1)', () => {
    expect(diffStats(SIMPLE_EDIT)).toEqual({ added: 1, removed: 1, partial: false });
  });

  it('ignora los diagnósticos LSP detrás del diff aunque traigan líneas - / +', () => {
    expect(diffStats(EDIT_WITH_LSP)).toEqual({ added: 1, removed: 1, partial: false });
  });

  it('salida truncada: cuenta lo que hay y marca partial', () => {
    expect(diffStats(TRUNCATED_EDIT)).toEqual({ added: 1, removed: 1, partial: true });
  });

  it('(no changes) → null', () => {
    expect(diffStats('File edited: src/a.ts\n\n(no changes)')).toBeNull();
  });

  it('write_file no tiene diff → null', () => {
    expect(diffStats('File created: p (12 bytes)')).toBeNull();
    expect(diffStats('File overwritten: p (12 bytes)')).toBeNull();
  });
});

describe('diffLines', () => {
  it('clasifica hunk/ctx/del/add y omite las cabeceras ---/+++ y lo posterior', () => {
    const withLsp = `${SIMPLE_EDIT}\n\nDiagnósticos:\n- error X`;
    expect(diffLines(withLsp)).toEqual([
      { kind: 'hunk', text: '@@ -1,3 +1,3 @@' },
      { kind: 'ctx', text: 'const a = 1;' },
      { kind: 'del', text: 'const b = 2;' },
      { kind: 'add', text: 'const b = 3;' },
      { kind: 'ctx', text: 'const c = 4;' },
    ]);
  });

  it('sin diff → []', () => {
    expect(diffLines('File created: p (12 bytes)')).toEqual([]);
  });
});

describe('execSummary', () => {
  it('lee status y exitCode del sobre y deja el stdout como body', () => {
    const out = [
      '<exec_result target="local" status="completed" exitCode="0" duration="120ms" cwd="D:\\x" maxBytes="30000">',
      '  <stdout>hola',
      'mundo</stdout>',
      '</exec_result>',
    ].join('\n');
    expect(execSummary(out)).toEqual({ exitCode: 0, status: 'completed', body: 'hola\nmundo' });
  });

  it('concatena stderr tras stdout', () => {
    const out = [
      '<exec_result target="local" status="completed" exitCode="0" duration="5ms">',
      '  <stdout>hola</stdout>',
      '  <stderr>aviso</stderr>',
      '</exec_result>',
    ].join('\n');
    expect(execSummary(out)).toEqual({ exitCode: 0, status: 'completed', body: 'hola\naviso' });
  });

  it('exitCode unknown → null', () => {
    const out = [
      '<exec_result target="local" status="timeout" exitCode="unknown" duration="30s">',
      '  <stdout></stdout>',
      '</exec_result>',
    ].join('\n');
    expect(execSummary(out)).toEqual({ exitCode: null, status: 'timeout', body: '' });
  });

  it('desescapa entidades en orden seguro (&amp; el último)', () => {
    const out =
      '<exec_result target="local" status="completed" exitCode="0" duration="1ms">\n' +
      '  <stdout>&lt;a&gt; &amp;amp;</stdout>\n' +
      '</exec_result>';
    expect(execSummary(out).body).toBe('<a> &amp;');
  });

  it('sin sobre devuelve la salida tal cual', () => {
    expect(execSummary('salida\nplana')).toEqual({
      exitCode: null,
      status: null,
      body: 'salida\nplana',
    });
  });

  it('sobre cortado a mitad de stdout: raspa lo que hay, sin etiquetas', () => {
    const out =
      '<exec_result target="local" status="completed" exitCode="0" duration="5ms" maxBytes="30000">\n' +
      '  <stdout>uno\ndos\ntres';
    expect(execSummary(out)).toEqual({ exitCode: 0, status: 'completed', body: 'uno\ndos\ntres' });
  });

  it('quita el salto final de stdout', () => {
    const out = [
      '<exec_result target="local" status="completed" exitCode="0" duration="3ms">',
      '  <stdout>a\nb\n</stdout>',
      '</exec_result>',
    ].join('\n');
    expect(execSummary(out).body).toBe('a\nb');
  });
});

describe('cardLabel', () => {
  it('recorta una ruta POSIX larga conservando el nombre del fichero', () => {
    const state = completed('read_file', {
      path: 'src/deep/nested/folders/that/are/very/long/indeed/component.tsx',
    }, '');
    expect(cardLabel(state)).toBe('…/indeed/component.tsx');
  });

  it('recorta una ruta de Windows larga conservando el nombre del fichero', () => {
    const state = completed('edit_file', {
      path: 'D:\\proyectos\\muy\\largos\\por\\aqui\\reporte-final.pdf',
    }, '');
    expect(cardLabel(state)).toBe('…/aqui/reporte-final.pdf');
  });

  it('exec muestra el comando', () => {
    const state = completed('exec', { command: 'git status --porcelain' }, '');
    expect(cardLabel(state)).toBe('git status --porcelain');
  });
});

describe('cardSummary', () => {
  it('edit_file resume el diff', () => {
    expect(cardSummary(completed('edit_file', { path: 'src/a.ts' }, SIMPLE_EDIT))).toBe('+1 −1');
  });

  it('exec correcto con 2 líneas', () => {
    const out = [
      '<exec_result target="local" status="completed" exitCode="0" duration="3ms">',
      '  <stdout>hola',
      'mundo</stdout>',
      '</exec_result>',
    ].join('\n');
    expect(cardSummary(completed('exec', { command: 'ls' }, out))).toBe('2 líneas');
  });

  it('exec a segundo plano (<exec_job>) → en segundo plano', () => {
    const out = [
      '<exec_job id="job_1" target="local" timeoutMs="120000">',
      '  ok:true',
      '</exec_job>',
    ].join('\n');
    expect(cardSummary(completed('exec', { command: 'sleep 30' }, out))).toBe('en segundo plano');
  });

  it('diff truncado añade … al resumen', () => {
    expect(cardSummary(completed('edit_file', { path: 'src/a.ts' }, TRUNCATED_EDIT))).toBe(
      '+1 −1…',
    );
  });

  it('read_file cuenta solo las líneas numeradas, sin el pie de offset', () => {
    expect(
      cardSummary(
        completed(
          'read_file',
          { path: 'src/a.ts' },
          `1: a\n2: b\n3: c\n(File has more lines. Use 'offset' to read beyond line 2000)`,
        ),
      ),
    ).toBe('3 líneas');
  });

  it('read_file: la numerada vacía del salto final no cuenta; la de en medio sí', () => {
    expect(cardSummary(completed('read_file', { path: 'src/a.ts' }, '1: a\n2: b\n3: c\n4: '))).toBe(
      '3 líneas',
    );
    expect(cardSummary(completed('read_file', { path: 'src/a.ts' }, '1: a\n2: \n3: b'))).toBe(
      '3 líneas',
    );
  });

  it('list_directory y read_skill no resumen', () => {
    expect(cardSummary(completed('list_directory', { path: 'src' }, 'a.ts\nb.ts\n'))).toBeNull();
    expect(cardSummary(completed('read_skill', { name: 'x' }, '1: paso'))).toBeNull();
  });

  it('tool desconocida → null', () => {
    expect(
      cardSummary(completed('store_decision', { decision: 'usar tsup' }, 'dec_x guardada')),
    ).toBeNull();
  });

  it('estado running → null', () => {
    const state: ToolCallState = { id: '1', name: 'edit_file', status: 'running', input: { path: 'src/a.ts' } };
    expect(cardSummary(state)).toBeNull();
  });
});

describe('diffTrailer', () => {
  it('sin diff o sin informe → \'\'', () => {
    expect(diffTrailer(SIMPLE_EDIT)).toBe('');
    expect(diffTrailer('File created: p (12 bytes)')).toBe('');
  });

  it('devuelve el informe LSP sin las líneas vacías del borde', () => {
    expect(diffTrailer(EDIT_WITH_LSP)).toBe(
      'Diagnósticos LSP de src/a.ts:\n- error TS2345 en línea 1\n+ sugerencia: revisar el tipo',
    );
  });
});
