import type { ConnectionState } from '../../ipc/native';
import type { ProtocolSession } from '../../protocol';
import { ORIGIN_LABEL } from '../../view/sessions';
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
 * Barra inferior (D4, §8): conexión con Stratum, provider y modelo de la sesión
 * que se mira, uso de contexto con los umbrales de la CLI, dónde corre y cuántas
 * sesiones están trabajando. Todo sale de las fotos del daemon (M12).
 */
export function StatusBar({
  connection,
  session,
  working,
}: {
  connection: ConnectionState;
  session: ProtocolSession | null;
  /** Sesiones con un run en marcha (de la foto de conjunto). */
  working: number;
}) {
  const { label, tone } = describeConnection(connection);
  const ctx = session?.context;
  return (
    <footer className="status-bar" aria-label="Estado">
      <span className="status-bar__item connection" role="status" aria-live="polite" data-tone={tone}>
        <span className="connection__dot" aria-hidden="true" />
        <span className="connection__label">{label}</span>
      </span>
      {session && (
        <span className="status-bar__item" title="Provider y modelo de esta sesión">
          {session.provider} / <span className="status-bar__model">{session.model}</span>
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
          <span className="status-bar__pct">{Math.round(ctx.pct)}%</span>
        </span>
      )}
      {session && (
        <span className="status-bar__item" title="Dónde corre esta sesión y desde dónde se inició">
          {session.host.kind === 'daemon' ? 'en el daemon' : 'en su terminal'}
          {session.origin ? ` · desde ${ORIGIN_LABEL[session.origin]}` : ''}
        </span>
      )}
      <span className="status-bar__spacer" />
      {working > 0 && (
        <span className="status-bar__item" aria-live="polite">
          {working === 1 ? '1 sesión trabajando' : `${working} sesiones trabajando`}
        </span>
      )}
    </footer>
  );
}
