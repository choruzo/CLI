import { PassThrough } from 'node:stream';
import React from 'react';
import { render } from 'ink';
import { describe, expect, it } from 'vitest';
import { MarkdownText } from '../MarkdownText.js';
import { unescapeHtml } from './entities.js';
import { tableColumnWidths } from './renderTokens.js';

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

async function frame(text: string, columns = 80): Promise<string> {
  const stdout = new PassThrough();
  const writes: string[] = [];
  Object.assign(stdout, { columns, rows: 40, isTTY: false });
  stdout.on('data', (chunk: Buffer) => writes.push(chunk.toString()));
  const app = render(React.createElement(MarkdownText, { text }), {
    stdout: stdout as unknown as NodeJS.WriteStream,
    debug: true,
  });
  await new Promise((r) => setTimeout(r, 30));
  app.unmount();
  return (writes.at(-1) ?? '').replace(ANSI, '');
}

describe('unescapeHtml', () => {
  it('deshace las entidades de marked en una sola pasada', () => {
    expect(unescapeHtml('a -&gt; b &lt;c&gt; &quot;q&quot; it&#39;s &amp;')).toBe(
      `a -> b <c> "q" it's &`,
    );
    expect(unescapeHtml('&amp;gt;')).toBe('&gt;');
  });
});

describe('MarkdownText', () => {
  it('pinta `>` y `&` tal cual, también en código en línea', async () => {
    const out = await frame('`venv/bin/python3 -> /usr/bin/python3` y a > b & c');
    expect(out).toContain('venv/bin/python3 -> /usr/bin/python3');
    expect(out).toContain('a > b & c');
    expect(out).not.toContain('&gt;');
  });

  it('dibuja las tablas en columnas, no como texto con barras', async () => {
    const out = await frame(
      '| Servicio | Estado |\n|---|---|\n| `asistente-hub` | restart loop |\n| panel web | **activo** |',
    );
    const lines = out.split('\n').map((l) => l.trimEnd());
    expect(out).not.toContain('|');
    const header = lines.find((l) => l.includes('Servicio'))!;
    const row = lines.find((l) => l.includes('panel web'))!;
    // La segunda columna empieza en la misma columna en todas las filas.
    expect(row.indexOf('activo')).toBe(header.indexOf('Estado'));
    expect(lines.some((l) => /^\s*─+\s+─+$/.test(l))).toBe(true);
  });
});

describe('tableColumnWidths', () => {
  it('deja el ancho natural si cabe', () => {
    expect(tableColumnWidths([5, 10], 40)).toEqual([5, 10]);
  });

  it('recorta las columnas más anchas hasta caber, sin bajar del mínimo', () => {
    expect(tableColumnWidths([10, 50], 32)).toEqual([10, 20]);
    expect(tableColumnWidths([40, 40, 40], 10)).toEqual([6, 6, 6]);
  });
});
