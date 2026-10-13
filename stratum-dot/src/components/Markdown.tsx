import { memo, type ReactNode } from 'react';

/**
 * Markdown del asistente, pintado **como elementos de React**: no hay HTML del
 * modelo en ningún momento (ni `innerHTML`, ni un parser que lo deje pasar), así
 * que lo que el modelo escriba como etiqueta se ve como texto.
 *
 * Es un subconjunto a propósito —párrafos, títulos, listas, citas, bloques y
 * trozos de código, negrita, cursiva y enlaces—: lo que no entiende (tablas,
 * imágenes) se queda como texto legible.
 *
 * Los enlaces **no navegan**: el webview de Dot no abre nada. Se enseña su
 * texto y, al lado, la dirección.
 */

type Block =
  | { kind: 'code'; text: string }
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'quote'; text: string }
  | { kind: 'rule' }
  | { kind: 'para'; text: string };

const FENCE = /^\s*(```|~~~)/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const ITEM = /^\s*(?:([-*+])|(\d+)[.)])\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;
const RULE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;

export function parseBlocks(source: string): Block[] {
  const blocks: Block[] = [];
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  let para: string[] = [];
  const flush = () => {
    if (para.length > 0) blocks.push({ kind: 'para', text: para.join('\n') });
    para = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (FENCE.test(line)) {
      flush();
      const body: string[] = [];
      i++;
      // Un bloque sin cerrar (el texto aún se está escribiendo) llega hasta el final.
      while (i < lines.length && !FENCE.test(lines[i]!)) body.push(lines[i++]!);
      blocks.push({ kind: 'code', text: body.join('\n') });
      continue;
    }
    if (line.trim() === '') {
      flush();
      continue;
    }
    if (RULE.test(line)) {
      flush();
      blocks.push({ kind: 'rule' });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      blocks.push({ kind: 'heading', level: heading[1]!.length, text: heading[2]! });
      continue;
    }
    const item = ITEM.exec(line);
    if (item) {
      flush();
      const ordered = item[2] !== undefined;
      const last = blocks[blocks.length - 1];
      if (last?.kind === 'list' && last.ordered === ordered) last.items.push(item[3]!);
      else blocks.push({ kind: 'list', ordered, items: [item[3]!] });
      continue;
    }
    const quote = QUOTE.exec(line);
    if (quote) {
      flush();
      const last = blocks[blocks.length - 1];
      if (last?.kind === 'quote') last.text += `\n${quote[1]!}`;
      else blocks.push({ kind: 'quote', text: quote[1]! });
      continue;
    }
    // Una línea sangrada tras un elemento de lista es su continuación.
    const last = blocks[blocks.length - 1];
    if (para.length === 0 && last?.kind === 'list' && /^\s{2,}\S/.test(line)) {
      last.items[last.items.length - 1] += `\n${line.trim()}`;
      continue;
    }
    para.push(line);
  }
  flush();
  return blocks;
}

const INLINE = /(`+)([^`]+?)\1|\*\*([^*]+?)\*\*|\*([^*\s][^*]*?)\*|\[([^\]]+)\]\(([^)\s]+)\)/g;

/** Solo se enseña la dirección de un enlace web; lo demás se queda en su texto. */
function shownAddress(address: string): string | null {
  return /^https?:\/\//i.test(address) ? address : null;
}

function inline(text: string, depth = 0): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const match of text.matchAll(INLINE)) {
    const at = match.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    last = at + match[0].length;
    if (match[2] !== undefined) {
      out.push(<code key={key++}>{match[2]}</code>);
    } else if (match[3] !== undefined) {
      out.push(<strong key={key++}>{depth < 3 ? inline(match[3], depth + 1) : match[3]}</strong>);
    } else if (match[4] !== undefined) {
      out.push(<em key={key++}>{depth < 3 ? inline(match[4], depth + 1) : match[4]}</em>);
    } else {
      const address = shownAddress(match[6]!);
      out.push(
        <span key={key++} className="md-link">
          {match[5]}
          {address && address !== match[5] ? <span className="muted"> ({address})</span> : null}
        </span>,
      );
    }
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function render(block: Block, index: number): ReactNode {
  switch (block.kind) {
    case 'code':
      return (
        <pre key={index} className="md-code">
          <code>{block.text}</code>
        </pre>
      );
    case 'heading':
      return (
        <p key={index} className="md-heading" role="heading" aria-level={Math.min(block.level + 2, 6)}>
          {inline(block.text)}
        </p>
      );
    case 'list': {
      const items = block.items.map((item, i) => <li key={i}>{inline(item)}</li>);
      return block.ordered ? <ol key={index}>{items}</ol> : <ul key={index}>{items}</ul>;
    }
    case 'quote':
      return <blockquote key={index}>{inline(block.text)}</blockquote>;
    case 'rule':
      return <hr key={index} />;
    case 'para':
      return <p key={index}>{inline(block.text)}</p>;
  }
}

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return <div className="md">{parseBlocks(text).map(render)}</div>;
});
