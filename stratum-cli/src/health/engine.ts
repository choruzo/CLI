/**
 * M23 — avisos de degradación (`docs/PRD_STRATUM_DOT.md` §23.11, M23): la
 * máquina de estados de la comprobación de acceso de un conector. **Pura**: de
 * lo que había y el resultado de una pasada sale el estado nuevo y el aviso,
 * si toca. Quien la llama (`daemon/health-monitor.ts`) mira, guarda y entrega.
 *
 * Una vez por causa: `auth` se avisa a la primera (una credencial rechazada no
 * se arregla sola); un fallo de otro tipo, al `HEALTH_FAILURES_BEFORE_NOTICE`
 * seguido (una caída corta no merece aviso). Lo ya avisado no se repite hasta
 * que vuelve a `ok`, y entonces se avisa una vez de que funciona.
 */

/** Lo que devuelve la comprobación de acceso de un conector (su `estado`). */
export type AccessStatus = 'ok' | 'auth' | 'unreachable' | 'error';

export const ACCESS_STATUSES: readonly AccessStatus[] = ['ok', 'auth', 'unreachable', 'error'];

/** Fallos seguidos (que no son `auth`) antes de avisar. */
export const HEALTH_FAILURES_BEFORE_NOTICE = 2;

/** Lo que ya se avisó de un conector. */
export type ConnectorNotified = 'auth' | 'failing' | null;

export interface ConnectorHealthState {
  /** Fallos seguidos que no son `auth`. En memoria: se olvida al reiniciar. */
  failures: number;
  notified: ConnectorNotified;
}

export const INITIAL_CONNECTOR_HEALTH: ConnectorHealthState = { failures: 0, notified: null };

export type ConnectorHealthNotice = 'auth' | 'failing' | 'recovered';

export interface ConnectorHealthStep {
  state: ConnectorHealthState;
  notice: ConnectorHealthNotice | null;
}

/** Lee el `estado` de una comprobación de acceso; lo que no se reconoce es `error`. */
export function accessStatusOf(estado: string): AccessStatus {
  return (ACCESS_STATUSES as readonly string[]).includes(estado)
    ? (estado as AccessStatus)
    : 'error';
}

export function stepConnectorHealth(
  prev: ConnectorHealthState,
  status: AccessStatus,
): ConnectorHealthStep {
  if (status === 'ok') {
    return {
      state: { failures: 0, notified: null },
      notice: prev.notified ? 'recovered' : null,
    };
  }
  if (status === 'auth') {
    return {
      state: { failures: 0, notified: 'auth' },
      notice: prev.notified === 'auth' ? null : 'auth',
    };
  }
  const failures = prev.failures + 1;
  // Ya avisado (de `auth` o de que falla): un fallo de red no dice si la
  // credencial se arregló, así que se queda como estaba y no se repite.
  if (prev.notified) return { state: { failures, notified: prev.notified }, notice: null };
  if (failures >= HEALTH_FAILURES_BEFORE_NOTICE) {
    return { state: { failures, notified: 'failing' }, notice: 'failing' };
  }
  return { state: { failures, notified: null }, notice: null };
}

/** La causa estable de un aviso: lo que no se repite. */
export function connectorCause(connector: string, notified: 'auth' | 'failing'): string {
  return `connector:${connector}:${notified}`;
}

export const BOX_IMAGE_CAUSE = 'box:image';
