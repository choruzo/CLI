import { useId, useState } from 'react';
import type { ToolCallState, ToolCallView } from '../../hooks/conversation-reducer';

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
  const bodyId = useId();
  const body = call.state === 'error' ? call.error : call.output;

  return (
    <div className="tool-call" data-state={call.state}>
      <button
        type="button"
        className="tool-call__header"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="tool-call__icon" aria-hidden="true">
          {STATE_ICON[call.state]}
        </span>
        <span className="tool-call__name">{call.name}</span>
        <span className="tool-call__state">{STATE_LABEL[call.state]}</span>
        {call.durationMs !== undefined && (
          <span className="tool-call__duration">{formatDuration(call.durationMs)}</span>
        )}
      </button>
      {open && (
        <div className="tool-call__body" id={bodyId}>
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
    </div>
  );
}
