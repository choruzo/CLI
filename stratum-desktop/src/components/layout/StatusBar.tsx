import type { ConversationStats, WorkspaceStatus } from '../../ipc/types';
import type { SidecarState } from '../../hooks/useSidecar';
import { formatBytes } from '../../ipc/files';
import { describeConnection } from './ConnectionIndicator';

/** Umbrales de color del contexto, los mismos que la StatusBar de la CLI. */
export function contextTone(pct: number): 'ok' | 'warn' | 'error' {
  if (pct < 60) return 'ok';
  if (pct < 85) return 'warn';
  return 'error';
}

export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n / 1000)}k`;
}

/**
 * Barra inferior (D4, §8): conexión, provider y modelo de la conversación
 * activa, uso de contexto con los umbrales de la CLI, tamaño de sus ficheros y
 * cuántas conversaciones están generando o en cola.
 */
export function StatusBar({
  sidecar,
  stats,
  workspace,
  generating,
  queued,
}: {
  sidecar: SidecarState;
  stats: ConversationStats | null;
  workspace: WorkspaceStatus | null;
  /** Conversaciones con un turno en marcha. */
  generating: number;
  /** Turnos esperando hueco de generación. */
  queued: number;
}) {
  const { label, tone } = describeConnection(sidecar);
  const ctx = stats?.context;
  return (
    <footer className="status-bar" aria-label="Estado">
      <span className="status-bar__item connection" role="status" aria-live="polite" data-tone={tone}>
        <span className="connection__dot" aria-hidden="true" />
        <span className="connection__label">{label}</span>
      </span>
      {stats && (
        <span className="status-bar__item" title="Provider y modelo de esta conversación">
          {stats.provider} / <span className="status-bar__model">{stats.model}</span>
        </span>
      )}
      {ctx && ctx.max > 0 && (
        <span
          className="status-bar__item"
          data-tone={contextTone(ctx.pct)}
          title={`${ctx.estimated ? 'Estimado: ' : ''}${ctx.used} de ${ctx.max} tokens de contexto`}
        >
          ctx {ctx.estimated ? '~' : ''}
          {formatTokens(ctx.used)} / {formatTokens(ctx.max)} ·{' '}
          <span className="status-bar__pct">{ctx.pct}%</span>
        </span>
      )}
      {workspace && workspace.state !== 'purged' && (
        <span className="status-bar__item" title="Tamaño de los ficheros de esta conversación">
          ficheros {formatBytes(workspace.sizeBytes)}
          {workspace.state === 'archived' ? ' (comprimidos)' : ''}
        </span>
      )}
      <span className="status-bar__spacer" />
      {(generating > 0 || queued > 0) && (
        <span className="status-bar__item" aria-live="polite">
          {generating > 0 && `${generating} generando`}
          {generating > 0 && queued > 0 && ' · '}
          {queued > 0 && `${queued} en cola`}
        </span>
      )}
    </footer>
  );
}
