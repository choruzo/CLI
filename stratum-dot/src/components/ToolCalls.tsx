import type { ProtocolToolCall } from '../protocol';
import { preview, type Tone } from '../protocol/view';
import { Dot } from './StatusBadge';

/**
 * `pending` y `running` se enseñan igual, como «Active»: `tool.started` se
 * publica al conocerse la llamada y puede estar esperando una aprobación o una
 * pausa, así que desde aquí no se puede afirmar que se esté ejecutando.
 */
const STATE: Record<ProtocolToolCall['state'], { label: string; tone: Tone }> = {
  pending: { label: 'Active', tone: 'active' },
  running: { label: 'Active', tone: 'active' },
  completed: { label: 'Done', tone: 'ok' },
  error: { label: 'Failed', tone: 'bad' },
  blocked: { label: 'Blocked', tone: 'muted' },
};

const SHOWN = 8;
/** Vista previa de una descripción. Ya viene redactada del anfitrión; aquí solo se acota. */
const DESCRIPTION_CHARS = 160;

export function ToolCalls({ calls }: { calls: ProtocolToolCall[] }) {
  if (calls.length === 0) return <p className="muted small">No tool calls in this run.</p>;
  const shown = calls.slice(-SHOWN).reverse();
  return (
    <ul className="tools" aria-label="Tool calls">
      {shown.map((call, index) => (
        <li key={`${call.id}:${call.subagentId ?? ''}:${index}`} data-state={call.state}>
          <Dot tone={STATE[call.state].tone} />
          <span className="mono">{call.name}</span>
          <span className="muted">{STATE[call.state].label}</span>
          {call.target && call.target !== 'local' ? <span className="mono muted">{call.target}</span> : null}
          <span className="tool-desc muted">{preview(call.description, DESCRIPTION_CHARS)}</span>
        </li>
      ))}
      {calls.length > SHOWN ? <li className="muted small">…and {calls.length - SHOWN} earlier</li> : null}
    </ul>
  );
}
