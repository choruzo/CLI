import { isValidElement, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { theme } from '../../../theme';

/**
 * Bloque ```visual de una respuesta: un fragmento HTML/CSS/SVG que el asistente
 * escribe para acompañar una explicación (skill `stratum-visuals`).
 *
 * Seguridad: el HTML viene del modelo, así que se pinta en un `<iframe srcdoc>`
 * con `sandbox="allow-same-origin"` y **sin** `allow-scripts` — ni `<script>`
 * ni `on*=` se ejecutan, ni formularios, ni ventanas, ni navegar la ventana
 * principal. `allow-same-origin` solo sirve para que este componente mida la
 * altura del documento: sin scripts dentro, no da al visual ningún poder sobre
 * la app (la combinación peligrosa es con `allow-scripts`). Además el documento
 * lleva su propia CSP (`VISUAL_CSP`), que se suma a la heredada de la ventana:
 * nada externo carga (imágenes, hojas de estilo, fuentes), así que un visual no
 * puede sacar datos por una URL.
 */

export const VISUAL_LANGUAGE = 'visual';
export const VISUAL_SANDBOX = 'allow-same-origin';
export const VISUAL_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src 'none'";
/** Más alto que esto, el visual hace scroll dentro de su marco. */
export const VISUAL_MAX_HEIGHT = 1200;
const INITIAL_HEIGHT = 160;

/** Paleta categórica para series sobre el fondo oscuro, más rejilla y ejes. */
export const VIZ_PALETTE = ['#F59E0B', '#2DD4BF', '#A78BFA', '#38BDF8', '#FB7185', '#A3E635'] as const;

/** Texto plano de los hijos de un `<code>` (el resaltado no lo parte: `visual` no es un lenguaje conocido). */
export function nodeText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join('');
  if (isValidElement<{ children?: ReactNode }>(node)) return nodeText(node.props.children);
  return '';
}

function rootVars(): string {
  const colors = Object.entries(theme).map(([k, v]) => `--color-${k}:${v};`);
  const viz = VIZ_PALETTE.map((c, i) => `--viz-${i + 1}:${c};`);
  return [...colors, ...viz, `--viz-grid:${theme.borderSubtle};`, `--viz-axis:${theme.textMuted};`].join('');
}

/**
 * Documento del iframe. La CSP va la primera del `<head>`, antes que nada del
 * modelo: un `<meta>` suyo más abajo solo podría añadir restricciones. Un
 * documento completo (`<html><body>…`) dentro del `<body>` lo arregla el parser.
 */
export function visualDocument(source: string): string {
  return (
    '<!doctype html><html><head><meta charset="utf-8">' +
    `<meta http-equiv="Content-Security-Policy" content="${VISUAL_CSP}">` +
    '<style>' +
    `:root{color-scheme:dark;${rootVars()}}` +
    '*{box-sizing:border-box}' +
    "html,body{margin:0;background:transparent;color:var(--color-textResponse);font:14px/1.5 'IBM Plex Sans',system-ui,-apple-system,'Segoe UI',sans-serif}" +
    'body{padding:12px;overflow-wrap:anywhere}' +
    'svg{max-width:100%;height:auto}' +
    // Un enlace no puede navegar el marco (ni a la propia app): se queda en texto.
    'a{pointer-events:none;color:inherit}' +
    '</style></head><body>' +
    source +
    '</body></html>'
  );
}

function VisualFrame({ source }: { source: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(INITIAL_HEIGHT);

  const measure = useCallback(() => {
    const doc = frame.current?.contentDocument;
    if (!doc?.documentElement) return;
    const h = Math.ceil(doc.documentElement.scrollHeight);
    if (h <= 0) return;
    // Con el alto ajustado al contenido sobra la barra de scroll del marco;
    // solo hace falta pasado el tope.
    doc.documentElement.style.overflowY = h > VISUAL_MAX_HEIGHT ? 'auto' : 'hidden';
    setHeight(Math.min(h, VISUAL_MAX_HEIGHT));
  }, []);

  // El ancho del mensaje cambia con la ventana y el texto se recoloca: se
  // vuelve a medir cuando cambia el tamaño del cuerpo del documento.
  const observer = useRef<ResizeObserver | null>(null);
  const onLoad = useCallback(() => {
    measure();
    observer.current?.disconnect();
    const body = frame.current?.contentDocument?.body;
    if (body && typeof ResizeObserver !== 'undefined') {
      observer.current = new ResizeObserver(measure);
      observer.current.observe(body);
    }
  }, [measure]);
  useEffect(() => () => observer.current?.disconnect(), []);

  return (
    <iframe
      ref={frame}
      className="visual-block__frame"
      title="Visual de la respuesta"
      sandbox={VISUAL_SANDBOX}
      srcDoc={visualDocument(source)}
      onLoad={onLoad}
      style={{ height }}
    />
  );
}

/**
 * Un bloque ```visual. Mientras la valla no está cerrada (la respuesta sigue
 * llegando) no se monta el marco: se repintaría con cada delta.
 */
export function VisualBlock({ children, settled }: { children?: ReactNode; settled: boolean }) {
  const [showSource, setShowSource] = useState(false);
  const source = nodeText(children).replace(/\n$/, '');
  if (!settled) {
    return (
      <div className="visual-block visual-block--pending" aria-busy="true">
        <span className="visual-block__label">Preparando visual…</span>
      </div>
    );
  }
  return (
    <div className="visual-block">
      <div className="code-block__header">
        <span className="code-block__lang">visual</span>
        <button
          type="button"
          className="visual-block__toggle"
          aria-pressed={showSource}
          onClick={() => setShowSource((v) => !v)}
        >
          {showSource ? 'Ver visual' : 'Ver HTML'}
        </button>
      </div>
      {showSource ? (
        <pre className="visual-block__source">
          <code>{source}</code>
        </pre>
      ) : (
        <VisualFrame source={source} />
      )}
    </div>
  );
}
