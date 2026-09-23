import { useMemo, useRef } from 'react';
import type { ConfigIssue } from '../../ipc/types';
import { tokenizeJson } from './json-highlight';

/**
 * Editor del `.stratumrc.json` crudo (Avanzado, D5): un `textarea` transparente
 * sobre un `<pre>` con el resaltado, con la misma tipografía y el scroll
 * sincronizado. El textarea sigue siendo el control real (foco, selección,
 * deshacer, lectores de pantalla); el `<pre>` es decorativo.
 */
export function JsonEditor({
  value,
  onChange,
  issues,
  disabled,
}: {
  value: string;
  onChange: (text: string) => void;
  issues: readonly ConfigIssue[];
  disabled?: boolean;
}) {
  const layer = useRef<HTMLPreElement>(null);
  const tokens = useMemo(() => tokenizeJson(value), [value]);
  const badLines = useMemo(
    () => new Set(issues.flatMap((i) => (i.line !== undefined ? [i.line] : []))),
    [issues],
  );
  const lineCount = value.split('\n').length;

  return (
    <div className="json-editor" data-invalid={issues.length > 0 || undefined}>
      <div className="json-editor__gutter" aria-hidden="true">
        {Array.from({ length: lineCount }, (_, i) => (
          <span key={i} data-bad={badLines.has(i + 1) || undefined}>
            {i + 1}
          </span>
        ))}
      </div>
      <div className="json-editor__surface">
        <pre ref={layer} className="json-editor__layer" aria-hidden="true">
          {tokens.map((t, i) =>
            t.kind === 'plain' ? (
              t.text
            ) : (
              <span key={i} className={`json-${t.kind}`}>
                {t.text}
              </span>
            ),
          )}
          {/* Un salto final no ocupa línea en un <pre>: se compensa. */}
          {'\n'}
        </pre>
        <textarea
          className="json-editor__input"
          aria-label="Contenido de .stratumrc.json"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          wrap="off"
          disabled={disabled}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onScroll={(e) => {
            const pre = layer.current;
            if (!pre) return;
            pre.scrollTop = e.currentTarget.scrollTop;
            pre.scrollLeft = e.currentTarget.scrollLeft;
            const gutter = e.currentTarget.parentElement?.previousElementSibling;
            if (gutter instanceof HTMLElement) gutter.scrollTop = e.currentTarget.scrollTop;
          }}
        />
      </div>
    </div>
  );
}
