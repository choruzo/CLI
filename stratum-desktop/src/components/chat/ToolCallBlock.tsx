import { useId, useState } from 'react';
import type { ToolCallState, ToolCallView } from '../../hooks/conversation-reducer';
import { Collapse } from './Collapse';
import { ICON, StrokeIcon } from './icons';

/** Tope de lo que se pinta de la entrada o la salida de una tool al expandir. */
export const TOOL_PREVIEW_CHARS = 4_000;

const STATE_LABEL: Record<ToolCallState, string> = {
  pending: 'preparando',
  running: 'ejecutando',
  completed: 'completado',
  error: 'error',
};

const STATE_ICON: Record<ToolCallState, string> = {
  pending: '◌',
  running: '◐',
  completed: '✓',
  error: '✗',
};

const TOOL_ICON: Record<string, string> = {
  read_file: ICON.file,
  write_file: ICON.filePen,
  edit_file: ICON.filePen,
  glob: ICON.search,
  grep: ICON.search,
  web_search: ICON.search,
  list_directory: ICON.folder,
  web_fetch: ICON.globe,
  store_decision: ICON.brain,
  recall_decisions: ICON.brain,
  todo: ICON.list,
  question: ICON.question,
  exec: ICON.terminal,
};

/** Icono de lo que hace una tool: fichero, búsqueda, web, memoria… */
export function toolIcon(name: string): string {
  if (TOOL_ICON[name]) return TOOL_ICON[name];
  if (name.startsWith('mcp__')) return ICON.plug;
  return ICON.tool;
}

function clip(text: string): string {
  if (text.length <= TOOL_PREVIEW_CHARS) return text;
  return `${text.slice(0, TOOL_PREVIEW_CHARS)}\n… (${text.length - TOOL_PREVIEW_CHARS} caracteres más)`;
}

function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/**
 * Bloque de una tool call con sus 4 estados (UI §5.1): `pending` mientras
 * llegan los argumentos, `running` al despacharse, `completed` / `error`.
 * Plegado por defecto; se expande para ver argumentos y resultado.
 */
export function ToolCallBlock({ call }: { call: ToolCallView }) {
  const [open, setOpen] = useState(false);
  // El cuerpo se monta al abrirlo por primera vez y se queda: así la
  // animación de cierre tiene algo que plegar, y una lista larga de tools
  // plegadas no pinta sus salidas.
  const [mounted, setMounted] = useState(false);
  const bodyId = useId();
  const body = call.state === 'error' ? call.error : call.output;

  return (
    <div className="tool-call" data-state={call.state} data-open={open || undefined}>
      <button
        type="button"
        className="tool-call__header"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => {
          setMounted(true);
          setOpen((v) => !v);
        }}
      >
        <span className="tool-call__icon" aria-hidden="true">
          {STATE_ICON[call.state]}
        </span>
        <span className="tool-call__kind" aria-hidden="true">
          <StrokeIcon d={toolIcon(call.name)} />
        </span>
        <span className="tool-call__name">{call.name}</span>
        <span className="tool-call__state">{STATE_LABEL[call.state]}</span>
        {call.durationMs !== undefined && (
          <span className="tool-call__duration">{formatDuration(call.durationMs)}</span>
        )}
        <span className="tool-call__chevron" aria-hidden="true">
          ›
        </span>
      </button>
      <Collapse open={open} id={bodyId}>
        {mounted && (
          <div className="tool-call__body">
            {call.input && (
              <>
                <div className="tool-call__label">Argumentos</div>
                <pre className="tool-call__pre">{clip(call.input)}</pre>
              </>
            )}
            {body && (
              <>
                <div className="tool-call__label">{call.state === 'error' ? 'Error' : 'Resultado'}</div>
                <pre className="tool-call__pre">{clip(body)}</pre>
              </>
            )}
          </div>
        )}
      </Collapse>
    </div>
  );
}
