import { useCallback, useEffect, useState } from 'react';
import { readContext } from '../../client/actions';
import type { NativeBridge } from '../../ipc/native';
import { toCommandError } from '../../ipc/native';
import type { ProtocolContextReport, ProtocolSessionMemory } from '../../protocol';
import { describeFailure } from '../../client/actions';
import { formatTokens } from './StatusBar';

const KIND_LABEL: Record<string, string> = {
  fact: 'Hecho',
  decision: 'Decisión',
  constraint: 'Restricción',
  preference: 'Preferencia',
  task: 'Tarea',
  result: 'Resultado',
  entity: 'Entidad',
};

/**
 * Contexto y memoria de la sesión que se mira (M11 visible desde Desktop):
 * `sessions.context` (qué recibe el modelo, por capas, en tokens estimados) y
 * `sessions.memory` (lo que la sesión compactó de lo antiguo, con su
 * procedencia). Es una **consulta** al daemon: lo pinta tal cual, no guarda
 * nada y no lee ningún fichero del daemon. La memoria de sesión no es
 * autoridad: es contexto derivado de la conversación.
 */
export function SessionContextPanel({
  native,
  sessionId,
  refreshKey,
}: {
  native: NativeBridge;
  sessionId: string | null;
  /** Cambia cuando puede haber cambiado (un run que termina). */
  refreshKey: string;
}) {
  const [report, setReport] = useState<ProtocolContextReport | null>(null);
  const [memory, setMemory] = useState<ProtocolSessionMemory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(() => {
    if (!sessionId) return;
    let current = true;
    setLoading(true);
    setError(null);
    readContext(native, sessionId)
      .then((r) => {
        if (!current) return;
        setReport(r.context);
        setMemory(r.memory);
      })
      .catch((err) => {
        if (current) setError(describeFailure('No se pudo leer el contexto', toCommandError(err)));
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    // Una respuesta que llega tras cambiar de sesión no se pinta.
    return () => {
      current = false;
    };
  }, [native, sessionId]);

  useEffect(() => {
    setReport(null);
    setMemory(null);
    return load();
  }, [load, refreshKey]);

  const ctx = report?.context ?? null;
  const conv = report?.conversation ?? null;
  const active = memory?.items.filter((i) => i.status === 'active' || i.status === 'conflict') ?? [];

  return (
    <div className="side-panel">
      <div className="side-panel__header">
        <h2 className="side-panel__title">Contexto</h2>
        <button type="button" className="button" onClick={() => load()} disabled={!sessionId || loading}>
          Recargar
        </button>
      </div>
      <div className="side-panel__body">
        {!sessionId && <p className="side-panel__empty">Elige una sesión.</p>}
        {error && (
          <p className="notice" data-tone="warning" role="alert">
            {error}
          </p>
        )}
        {sessionId && report && !ctx && (
          <p className="side-panel__empty">
            La sesión está guardada y aún no se ha montado: el contexto se ve tras su primer turno.
          </p>
        )}
        {ctx && (
          <section className="conv-group" aria-label="Contexto activo">
            <h3 className="conv-group__title">
              Contexto activo {ctx.estimated ? '(estimado)' : ''}
            </h3>
            <dl className="context-grid">
              <dt>Entrada</dt>
              <dd>
                {formatTokens(ctx.input)} / {formatTokens(ctx.usableInput)}
              </dd>
              <dt>Sistema</dt>
              <dd>{formatTokens(ctx.system)}</dd>
              <dt>Tools</dt>
              <dd>{formatTokens(ctx.tools)}</dd>
              <dt>Memoria de sesión</dt>
              <dd>{formatTokens(ctx.sessionMemory)}</dd>
              <dt>Reciente</dt>
              <dd>
                {formatTokens(ctx.recent)} · {ctx.activeMessages} mensajes
              </dd>
            </dl>
          </section>
        )}
        {conv && (
          <section className="conv-group" aria-label="Conversación guardada">
            <h3 className="conv-group__title">Conversación guardada</h3>
            <p className="side-panel__empty">
              {conv.storedMessages} mensajes guardados · {conv.compactions}{' '}
              {conv.compactions === 1 ? 'compactación' : 'compactaciones'}
              {conv.compacting ? ' · compactando…' : ''}
            </p>
            {conv.lastCompactionError && (
              <p className="notice" data-tone="warning">
                Última compactación aplazada: {conv.lastCompactionError}
              </p>
            )}
          </section>
        )}
        {memory && (memory.summary || active.length > 0) && (
          <section className="conv-group" aria-label="Memoria de sesión">
            <h3 className="conv-group__title">Memoria de sesión</h3>
            <p className="side-panel__empty">
              Lo que la sesión resumió de su conversación antigua. Es contexto, no autoridad.
            </p>
            {memory.summary && <p className="memory-summary">{memory.summary.text}</p>}
            <ul className="memory-items">
              {active.map((item) => (
                <li key={item.id} data-status={item.status}>
                  <strong>{KIND_LABEL[item.kind] ?? item.kind}</strong> · {item.text}
                  {item.status === 'conflict' && ' (en conflicto)'}
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}
