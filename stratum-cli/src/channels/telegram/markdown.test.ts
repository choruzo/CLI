import { describe, expect, it } from 'vitest';
import { escapeHtml, renderTelegramMarkdown } from './markdown.js';

const html = (md: string): string =>
  renderTelegramMarkdown(md)
    .map((c) => c.html)
    .join('\n');

/** Cada apertura de las etiquetas que emitimos tiene su cierre, en orden. */
function balanced(s: string): boolean {
  const stack: string[] = [];
  for (const m of s.matchAll(/<(\/?)(b|i|s|code|pre|a|blockquote)\b[^>]*>/g)) {
    if (m[1] === '') stack.push(m[2]!);
    else if (stack.pop() !== m[2]) return false;
  }
  return stack.length === 0;
}

describe('markdown de Telegram (M18 6D)', () => {
  it('escapa lo que HTML interpretaría', () => {
    expect(escapeHtml('<script>&')).toBe('&lt;script&gt;&amp;');
    expect(html('<script>alert(1)</script> & co')).toBe(
      '&lt;script&gt;alert(1)&lt;/script&gt; &amp; co',
    );
  });

  it('negrita, cursiva, código, tachado y enlace', () => {
    expect(html('**fuerte** y __otra__')).toBe('<b>fuerte</b> y <b>otra</b>');
    expect(html('*it* y _it2_')).toBe('<i>it</i> y <i>it2</i>');
    expect(html('usa `a<b` aquí')).toBe('usa <code>a&lt;b</code> aquí');
    expect(html('~~fuera~~')).toBe('<s>fuera</s>');
    expect(html('[doc](https://x.dev/a?b=1&c="2")')).toBe(
      '<a href="https://x.dev/a?b=1&amp;c=&quot;2&quot;">doc</a>',
    );
  });

  it('dentro del código no se interpreta nada', () => {
    expect(html('`**no**`')).toBe('<code>**no**</code>');
  });

  it('snake_case y a*b*c no se vuelven cursiva; un delimitador sin pareja es texto', () => {
    expect(html('snake_case_name y file_name.ts')).toBe('snake_case_name y file_name.ts');
    expect(html('a*b*c y 2*3*4')).toBe('a*b*c y 2*3*4');
    expect(html('**abierta y *suelta')).toBe('**abierta y *suelta');
  });

  it('un enlace que no es http(s) no se convierte', () => {
    const out = html('[clic](javascript:alert(1))');
    expect(out).not.toContain('<a');
    expect(out).toBe('[clic](javascript:alert(1))');
  });

  it('bloque de código: escapado, con lenguaje o sin él, sin formato inline', () => {
    expect(html('```ts\nconst a = "<b>**x**</b>";\n```')).toBe(
      '<pre><code class="language-ts">const a = "&lt;b&gt;**x**&lt;/b&gt;";</code></pre>',
    );
    expect(html('```\nplano\n```')).toBe('<pre>plano</pre>');
    expect(html('~~~\ncon tildes\n~~~')).toBe('<pre>con tildes</pre>');
  });

  it('una valla sin cerrar llega hasta el final', () => {
    const out = html('antes\n```py\nprint(1)\nprint(2)');
    expect(out).toBe('antes\n<pre><code class="language-py">print(1)\nprint(2)</code></pre>');
  });

  it('tabla: columnas alineadas en <pre>, sin fila separadora ni barras exteriores', () => {
    const out = html('| Nombre | N |\n|---|:-:|\n| **ab** | 10 |\n| c | 2 |');
    expect(out).toBe('<pre>Nombre | N\nab     | 10\nc      | 2</pre>');
  });

  it('tabla ancha: una ficha por fila, primera celda en negrita y Columna: valor', () => {
    const md = [
      'Antes:',
      '| Fichero | Qué hace | Dónde lo ejecutas |',
      '|---|---|---|',
      '| `README.md` | Plan completo, fases y mapa hardware | — |',
      '| 02_entrenar_qlora.py | QLoRA del **Qwen3-4B** con TRL | Server, R9700 |',
    ].join('\n');
    expect(html(md)).toBe(
      'Antes:\n' +
        '<b><code>README.md</code></b>\n<i>Qué hace</i>: Plan completo, fases y mapa hardware\n' +
        '──────\n' +
        '<b>02_entrenar_qlora.py</b>\n<i>Qué hace</i>: QLoRA del <b>Qwen3-4B</b> con TRL\n' +
        '<i>Dónde lo ejecutas</i>: Server, R9700',
    );
    const [chunk] = renderTelegramMarkdown(md);
    // El respaldo es el markdown original, con las fichas separadas por una línea en blanco.
    expect(chunk!.plain).toBe(md.replace('— |\n', '— |\n\n'));
    expect(balanced(chunk!.html)).toBe(true);
  });

  it('tabla ancha que no cabe: se trocea por filas, sin partir una ficha', () => {
    const row = (n: number): string => `| fila ${n} | ${'x'.repeat(40)} |`;
    const md = ['| A | B |', '|---|---|', ...Array.from({ length: 6 }, (_, n) => row(n))].join(
      '\n',
    );
    const chunks = renderTelegramMarkdown(md, 120);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.html.length).toBeLessThanOrEqual(120);
      expect(balanced(c.html)).toBe(true);
      // La regla separa fichas: nunca abre un trozo.
      expect(c.html.startsWith('<b>')).toBe(true);
    }
    expect(chunks.map((c) => c.html).join('\n\n')).toContain(
      '<b>fila 5</b>\n<i>B</i>: ' + 'x'.repeat(40),
    );
  });

  it('el umbral: una tabla de 32 columnas de ancho sigue en <pre>, de 33 pasa a fichas', () => {
    const table = (w: number): string => `| A | B |\n|---|---|\n| a | ${'b'.repeat(w - 4)} |`;
    expect(html(table(32))).toMatch(/^<pre>/);
    expect(html(table(33))).toMatch(/^<b>a<\/b>/);
  });

  it('encabezado, lista, numerada, cita y regla', () => {
    expect(html('## Título **x**')).toBe('<b>Título x</b>');
    expect(html('- uno\n  * sub\n+ tres')).toBe('• uno\n  • sub\n• tres');
    expect(html('1. primero')).toBe('1. primero');
    expect(html('> cita *i*\n> dos\n\nfuera')).toBe(
      '<blockquote>cita <i>i</i>\ndos</blockquote>\n\nfuera',
    );
    expect(html('---')).toBe('──────');
  });

  it('un texto largo da varios trozos que caben, equilibrados y con plain que cabe', () => {
    const para = '**negrita** y `código` con <angulos> & más texto de relleno.';
    const md = Array.from({ length: 40 }, () => para).join('\n\n');
    const chunks = renderTelegramMarkdown(md, 300);
    expect(chunks.length).toBeGreaterThan(3);
    for (const c of chunks) {
      expect(c.html.length).toBeLessThanOrEqual(300);
      expect(c.plain.length).toBeLessThanOrEqual(300);
      expect(c.html.trim()).not.toBe('');
      expect(c.plain.trim()).not.toBe('');
      expect(balanced(c.html)).toBe(true);
    }
  });

  it('un código mayor que max se parte en varios <pre> completos', () => {
    const body = Array.from({ length: 50 }, (_, i) => `linea <${i}> & x`).join('\n');
    const chunks = renderTelegramMarkdown('```js\n' + body + '\n```', 200);
    expect(chunks.length).toBeGreaterThan(2);
    for (const c of chunks) {
      expect(c.html.length).toBeLessThanOrEqual(200);
      expect(c.plain.length).toBeLessThanOrEqual(200);
      expect(c.html.startsWith('<pre><code class="language-js">')).toBe(true);
      expect(c.html.endsWith('</code></pre>')).toBe(true);
      expect(balanced(c.html)).toBe(true);
    }
    const joined = chunks.map((c) => c.plain).join('\n');
    expect(joined).toBe(body);
  });

  it('un párrafo mayor que max se parte en plano y escapado; nunca un trozo vacío', () => {
    const md = '**' + '<&> palabra '.repeat(100) + '**';
    const chunks = renderTelegramMarkdown(md, 120);
    expect(chunks.length).toBeGreaterThan(2);
    for (const c of chunks) {
      expect(c.html.length).toBeLessThanOrEqual(120);
      expect(c.html.trim()).not.toBe('');
      expect(balanced(c.html)).toBe(true);
    }
    expect(renderTelegramMarkdown('')).toEqual([]);
    expect(renderTelegramMarkdown('  \n\n  ')).toEqual([]);
    expect(renderTelegramMarkdown('```\n```')).toEqual([]);
  });
});
