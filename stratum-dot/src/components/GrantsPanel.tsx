import { useState } from 'react';
import { useNative } from '../bridge/context';
import { toCommandError } from '../bridge/native';
import { describeCommandError } from '../app/actions';
import { useNow } from '../app/useNow';
import type { ProtocolSessionSnapshot } from '../protocol';
import { activeGrants, grantMinutesLeft } from '../protocol/interactions';

interface Props {
  snapshot: ProtocolSessionSnapshot;
  /** Hay conexión con el daemon y este Dot puede conducir (`control`). */
  canControl: boolean;
}

/**
 * M17 — las concesiones vigentes de una sesión («permitir 10/30/60 minutos»):
 * qué tool y target abarcan, cuántos minutos les quedan y un botón para
 * revocarlas. Revocar solo resta autoridad: va por la conexión principal, sin
 * confirmación nativa.
 *
 * **Sin optimismo**: revocar no quita la fila; la quita la foto (`grant.ended`).
 * Una concesión cuyo `expiresAt` ya pasó se oculta aunque aún no haya llegado.
 */
export function GrantsPanel({ snapshot, canControl }: Props) {
  const native = useNative();
  // Los minutos que quedan se redondean hacia arriba: basta con refrescar cada 30 s.
  const now = useNow(30_000);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const grants = activeGrants(snapshot, now);
  if (grants.length === 0) return null;
  const sessionId = snapshot.session.id;

  const revoke = async (grantId: string) => {
    setError(null);
    setBusy(grantId);
    try {
      await native.grantsRevoke(sessionId, grantId);
    } catch (err) {
      const failure = toCommandError(err);
      setError(
        failure.kind === 'unknown'
          ? 'Result unknown: the connection dropped before the daemon answered. It was not sent again — the list shows whether the grant is still active.'
          : failure.code === 'NOT_FOUND'
            ? 'That grant no longer exists.'
            : describeCommandError(failure),
      );
      if (failure.kind === 'unknown' || failure.code === 'NOT_FOUND') {
        void native.resyncSession(sessionId).catch(() => undefined);
      }
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="card grants" aria-label="Active grants" data-grants>
      <h4>Active grants</h4>
      <ul className="grant-list">
        {grants.map((grant) => (
          <li key={grant.id} data-grant={grant.id}>
            <span className="mono">
              {grant.tool}
              {grant.target ? ` on ${grant.target}` : ' (any target)'}
            </span>
            <span className="muted small"> · {grantMinutesLeft(grant, now)} min left</span>
            <button
              type="button"
              className="btn small"
              disabled={!canControl || busy !== null}
              aria-label={`Revoke the grant for ${grant.tool}${grant.target ? ` on ${grant.target}` : ''}`}
              onClick={() => void revoke(grant.id)}
            >
              Revoke
            </button>
          </li>
        ))}
      </ul>
      {error ? (
        <p className="note bad" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
