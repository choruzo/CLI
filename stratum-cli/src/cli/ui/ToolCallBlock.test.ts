import { describe, expect, it } from 'vitest';
import React from 'react';
import { Writable } from 'node:stream';
import { render } from 'ink';
import { errorHeadline, ToolCallBlock, type ToolCallState } from './ToolCallBlock.js';

function failed(
  name: string,
  errorMsg: string,
  input: Record<string, unknown> = {},
): ToolCallState {
  return { id: 'c1', name, status: 'error', errorMsg, input };
}

describe('errorHeadline', () => {
  it('de un exec fallido enseña el código de salida y el comando, no el sobre', () => {
    const msg =
      '<exec_result target="local" status="exited" exitCode="3" duration="36ms" cwd="/home" maxBytes="1">\n  <stdout></stdout>';
    expect(errorHeadline(failed('exec', msg, { command: 'systemctl status x' }))).toBe(
      'exit 3 │ systemctl status x',
    );
  });

  it('distingue timeout y cancelado', () => {
    const msg = (status: string) =>
      `<exec_result target="local" status="${status}" exitCode="unknown" duration="1ms">`;
    expect(errorHeadline(failed('exec', msg('timeout'), { command: 'sleep 99' }))).toBe(
      'timeout │ sleep 99',
    );
    expect(errorHeadline(failed('exec', msg('cancelled')))).toBe('cancelado');
  });

  it('cualquier otro error: su primera línea', () => {
    expect(errorHeadline(failed('write', 'Tool "write" not found\nmás'))).toBe(
      'Tool "write" not found',
    );
  });
});

// Salida real de `edit_file` en una edición sencilla.
const EDIT_OUTPUT = [
  'File edited: src/app/feature/Service.ts',
  '',
  '--- src/app/feature/Service.ts',
  '+++ src/app/feature/Service.ts',
  '@@ -1,3 +1,3 @@',
  ' const a = 1;',
  '-const b = 2;',
  '+const b = 3;',
  ' const c = 4;',
].join('\n');

const execEnvelope = (...stdout: string[]): string =>
  [
    '<exec_result target="local" status="completed" exitCode="0" duration="12ms" cwd="D:\\x" maxBytes="30000">',
    `  <stdout>${stdout.join('\n')}</stdout>`,
    '</exec_result>',
  ].join('\n');

/**
 * Último fotograma del bloque renderizado en un stdout falso (sin ANSI: el
 * stream no es TTY, así que ink apaga el color).
 */
async function frameOf(state: ToolCallState, expanded = false): Promise<string> {
  const frames: string[] = [];
  const stdout = new Writable({
    write(chunk: unknown, _enc: unknown, cb: () => void) {
      frames.push(String(chunk));
      cb();
    },
  }) as unknown as NodeJS.WriteStream;
  const app = render(React.createElement(ToolCallBlock, { state, expanded }), {
    stdout,
    patchConsole: false,
  });
  await new Promise((r) => setImmediate(r));
  const frame = [...frames].reverse().find((f) => f.trim() !== '') ?? '';
  app.unmount();
  return frame.replace(/\u001B\[[0-9;]*[A-Za-z]/g, '');
}

describe('ToolCallBlock (render)', () => {
  const done = (name: string, input: Record<string, unknown>, output: string): ToolCallState => ({
    id: 'c1',
    name,
    status: 'completed',
    input,
    output,
  });

  it('un edit_file completado muestra +1 −1 y la ruta recortada', async () => {
    const frame = await frameOf(
      done(
        'edit_file',
        { path: 'src/features/pagos/ventas/reglas/largas/de/verdad/Service.ts' },
        EDIT_OUTPUT,
      ),
    );
    expect(frame).toContain('+1 −1');
    expect(frame).toContain('…/verdad/Service.ts');
    expect(frame).toContain('▸'); // plegado: expansible pero no expandido
  });

  it('expandido muestra el diff con la línea añadida por `+`', async () => {
    const frame = await frameOf(done('edit_file', { path: 'src/a.ts' }, EDIT_OUTPUT), true);
    expect(frame).toContain('+const b = 3;');
    expect(frame).toContain('-const b = 2;');
    expect(frame).not.toContain('File edited:');
  });

  it('exec expandido enseña la cola del body, sin las etiquetas del sobre', async () => {
    const stdout = Array.from({ length: 12 }, (_, i) => `linea-${String(i + 1).padStart(2, '0')}`);
    const frame = await frameOf(done('exec', { command: 'ls' }, execEnvelope(...stdout)), true);
    expect(frame).toContain('[+2 líneas antes]');
    expect(frame).toContain('linea-12');
    expect(frame).not.toContain('linea-01');
    expect(frame).not.toContain('<stdout>');
  });

  it('un read_file completado muestra N líneas', async () => {
    const frame = await frameOf(done('read_file', { path: 'src/a.ts' }, '1: a\n2: b\n3: c\n'));
    expect(frame).toContain('3 líneas');
  });

  it('exec con salto final: la cola no cuenta una fila vacía de más', async () => {
    const stdout = Array.from({ length: 14 }, (_, i) => `linea-${String(i + 1).padStart(2, '0')}`);
    const out = execEnvelope(...stdout).replace('</stdout>', '\n</stdout>');
    const frame = await frameOf(done('exec', { command: 'ls' }, out), true);
    expect(frame).toContain('[+4 líneas antes]');
    expect(frame).toContain('linea-14');
    expect(frame).not.toContain('linea-01');
  });

  it('exec_job expandido enseña el sobre tal cual, sin cola', async () => {
    const out = [
      '<exec_job id="job_1" target="local" timeoutMs="120000">',
      '  ok:true',
      '</exec_job>',
    ].join('\n');
    const frame = await frameOf(done('exec', { command: 'sleep 30' }, out), true);
    expect(frame).toContain('<exec_job');
    expect(frame).toContain('ok:true');
  });

  it('exec con error expandido enseña la cola del body, no el sobre', async () => {
    const stdout = Array.from({ length: 15 }, (_, i) => `linea-${String(i + 1).padStart(2, '0')}`);
    const msg = [
      '<exec_result target="local" status="exited" exitCode="1" duration="36ms" cwd="/home" maxBytes="1">',
      `  <stdout>${stdout.join('\n')}</stdout>`,
      '</exec_result>',
    ].join('\n');
    const frame = await frameOf(failed('exec', msg, { command: 'systemctl status x' }), true);
    expect(frame).toContain('[+5 líneas antes]');
    expect(frame).toContain('linea-15');
    expect(frame).not.toContain('linea-01');
    expect(frame).not.toContain('<stdout>');
  });

  it('diff truncado añade … al resumen', async () => {
    const out = [
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
    const frame = await frameOf(done('edit_file', { path: 'src/a.ts' }, out));
    expect(frame).toContain('+1 −1…');
  });

  it('expandido pinta el informe LSP bajo el diff', async () => {
    const out = `${EDIT_OUTPUT}\n\nDiagnósticos LSP de src/app/feature/Service.ts:\n- error TS2345 en línea 1`;
    const frame = await frameOf(done('edit_file', { path: 'src/a.ts' }, out), true);
    expect(frame).toContain('Diagnósticos LSP');
    expect(frame).toContain('+const b = 3;');
  });
});
