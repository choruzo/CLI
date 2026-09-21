import { memo, useRef, type ReactNode } from 'react';
import ReactMarkdown, { type Components, type Options } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { common } from 'lowlight';
import { EMPTY_SPLIT, isClosedFence, splitBlocks, type SplitState } from './blocks';
import { openExternal } from '../../../ipc/external';

/**
 * Render del markdown del asistente (15.13).
 *
 * Seguridad: el texto viene de un modelo y puede traer contenido hostil (lo que
 * devolvió un `web_fetch`, por ejemplo). react-markdown no interpreta HTML
 * crudo (sin `rehype-raw` se pinta como texto), el resaltado produce nodos y no
 * HTML inyectado, `urlTransform` solo deja pasar `http(s):` y `mailto:`, las
 * imágenes se sustituyen por un enlace (la CSP ya bloquea las remotas) y un
 * enlace nunca navega el webview: se abre en el navegador del sistema.
 */

const SAFE_URL = /^(https?:|mailto:)/i;

export function safeUrl(url: string): string {
  return SAFE_URL.test(url.trim()) ? url : '';
}

/**
 * Enlace de una respuesta. Deliberadamente **no** es un `<a href>`: sin URL en
 * el DOM, ni el clic central, ni el menú contextual («abrir en…»), ni un
 * arrastre pueden hacer navegar al webview. Es un botón con rol de enlace que
 * solo sabe llamar a `openExternal`.
 */
function ExternalLink({ href, children, title }: { href?: string; title?: string; children?: ReactNode }) {
  if (!href) return <span className="md-link md-link--dead">{children}</span>;
  return (
    <button
      type="button"
      role="link"
      className="md-link"
      title={title ?? href}
      onClick={() => void openExternal(href)}
    >
      {children}
    </button>
  );
}

const components: Components = {
  a: ({ href, title, children }) => (
    <ExternalLink href={href} title={title}>
      {children}
    </ExternalLink>
  ),
  img: ({ src, alt }) => {
    const href = typeof src === 'string' ? safeUrl(src) : '';
    return (
      <ExternalLink href={href || undefined}>
        [imagen{alt ? `: ${alt}` : ''}]
      </ExternalLink>
    );
  },
};

const PLAIN: Options['rehypePlugins'] = [];
const HIGHLIGHT: Options['rehypePlugins'] = [
  [rehypeHighlight, { languages: common, detect: false, plainText: ['text', 'txt'] }],
];
const REMARK: Options['remarkPlugins'] = [remarkGfm];

interface BlockProps {
  raw: string;
  /** El bloque ya no va a cambiar: si es código, se resalta. */
  settled: boolean;
}

/**
 * Un bloque de primer nivel. Memoizado por su texto: mientras llega la
 * respuesta, los bloques anteriores al último no se vuelven a parsear.
 */
export const MarkdownBlock = memo(function MarkdownBlock({ raw, settled }: BlockProps) {
  // Una valla cerrada y seguida de salto de línea ya no puede cambiar aunque
  // sea el último bloque: lo siguiente que llegue abrirá otro.
  const highlight = isClosedFence(raw) && (settled || raw.endsWith('\n'));
  return (
    <ReactMarkdown
      remarkPlugins={REMARK}
      rehypePlugins={highlight ? HIGHLIGHT : PLAIN}
      components={components}
      urlTransform={safeUrl}
    >
      {raw}
    </ReactMarkdown>
  );
});

interface MarkdownRendererProps {
  text: string;
  /** La respuesta sigue llegando: el último bloque puede cambiar. */
  streaming?: boolean;
}

export function MarkdownRenderer({ text, streaming = false }: MarkdownRendererProps) {
  const split = useRef<SplitState>(EMPTY_SPLIT);
  split.current = splitBlocks(text, split.current);
  const { blocks } = split.current;
  return (
    <div className="markdown">
      {blocks.map((b, i) => (
        <MarkdownBlock
          // El offset identifica el bloque: un delta solo cambia el último.
          key={b.offset}
          raw={b.raw}
          settled={!streaming || i < blocks.length - 1}
        />
      ))}
    </div>
  );
}
