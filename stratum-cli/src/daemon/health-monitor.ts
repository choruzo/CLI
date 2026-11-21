/**
 * M23 — avisos de degradación (`docs/PRD_STRATUM_DOT.md` §23.11, M23): el
 * daemon mira, **sin el LLM**, si algo de lo que depende el asistente dejó de
 * funcionar sin que nadie lo viera, y lo avisa una vez por causa
 * (`health.notice`, `docs/protocol.md` §34).
 *
 * Qué mira, en una pasada a los `firstDelayMs` de arrancar y luego cada
 * `tickMs`, una a la vez:
 *  - La comprobación de acceso (`access` del manifiesto) de cada conector
 *    activo que la declare, por la misma sonda que los vigilantes (la caja de
 *    conectores, nunca el anfitrión). Su `estado` lo clasificó el conector;
 *    aquí no se infiere nada del texto. La máquina de estados es pura
 *    (`health/engine.ts`).
 *  - Si la caja del agente o la de conectores existe con una imagen o ajustes
 *    anteriores (`outdated`). Se avisa una vez y se olvida en silencio cuando
 *    deja de estarlo.
 *
 * Suspendido (sin caja de conectores, sin configurar) no cambia nada: eso ya lo
 * avisan los vigilantes y `doctor`. Un conector que se desactiva se olvida sin
 * avisar. Un aviso que no se entrega **no** se marca: se reintenta en la pasada
 * siguiente. No importa `daemon.ts`.
 */
import { getLogger } from '../logging/index.js';
import type { ProtocolHealthNotice } from '../protocol/index.js';
import type { WatchProbe } from '../watches/probe.js';
import {
  BOX_IMAGE_CAUSE,
  INITIAL_CONNECTOR_HEALTH,
  accessStatusOf,
  connectorCause,
  stepConnectorHealth,
  type AccessStatus,
  type ConnectorHealthNotice,
  type ConnectorHealthState,
} from '../health/engine.js';
import { boxImageText, connectorHealthText } from '../health/notice.js';
import type { HealthStore } from '../health/store.js';

const log = getLogger('health');

export const HEALTH_FIRST_DELAY_MS = 2 * 60_000;
export const HEALTH_TICK_MS = 30 * 60_000;

/** Un conector activo con comprobación de acceso. */
export interface HealthConnector {
  id: string;
  name: string;
  /** La tool de su comprobación de acceso (`access`). */
  tool: string;
}

type BoxState = 'unavailable' | 'absent' | 'stopped' | 'running';

export interface HealthBox {
  status(): Promise<{ state: BoxState; outdated: boolean }>;
  connectorsStatus(): Promise<{ state: BoxState; outdated: boolean }>;
}

/** El resultado de la última comprobación de acceso de un conector (para `doctor`). */
export interface HealthAccessResult {
  status: AccessStatus;
  /** El `detalle` que dio el conector, ya neutralizado. */
  detail: string;
  at: number;
}

export interface HealthMonitorOptions {
  store: HealthStore;
  probe: WatchProbe;
  /** Los conectores activos que declaran comprobación de acceso, leídos en cada pasada. */
  connectors: () => HealthConnector[];
  /** `null`: la caja no está habilitada y no se mira su imagen. */
  box: HealthBox | null;
  notify(notice: ProtocolHealthNotice): Promise<void>;
  now: () => number;
  firstDelayMs?: number;
  tickMs?: number;
}

function messageOf(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 300);
}

export class HealthMonitor {
  private readonly states = new Map<string, ConnectorHealthState>();
  private readonly results = new Map<string, HealthAccessResult>();
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private stopped = false;

  constructor(private readonly opts: HealthMonitorOptions) {}

  start(): void {
    this.opts.store.load();
    // Lo avisado antes de reiniciar: no se repite.
    for (const cause of this.opts.store.causes()) {
      const m = /^connector:(.+):(auth|failing)$/.exec(cause);
      if (m) this.states.set(m[1]!, { failures: 0, notified: m[2] as 'auth' | 'failing' });
    }
    this.schedule(this.opts.firstDelayMs ?? HEALTH_FIRST_DELAY_MS);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Espera a la pasada en curso, si la hay (tests y apagado). */
  async idle(): Promise<void> {
    await this.running;
  }

  /** Lo último que dijo la comprobación de acceso de cada conector. */
  accessResults(): Map<string, HealthAccessResult> {
    return new Map(this.results);
  }

  /** Una pasada ahora (tests). Si ya hay una en curso, espera a esa. */
  runOnce(): Promise<void> {
    if (!this.running) {
      this.running = this.pass().finally(() => {
        this.running = null;
      });
    }
    return this.running;
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runOnce().finally(() => this.schedule(this.opts.tickMs ?? HEALTH_TICK_MS));
    }, ms);
    this.timer.unref?.();
  }

  private async pass(): Promise<void> {
    try {
      await this.checkBox();
    } catch (err) {
      log.warn('health: box check failed', { reason: messageOf(err) });
    }
    let connectors: HealthConnector[];
    try {
      connectors = this.opts.connectors();
    } catch (err) {
      log.warn('health: connectors could not be listed', { reason: messageOf(err) });
      return;
    }
    this.forgetOthers(new Set(connectors.map((c) => c.id)));
    for (const connector of connectors) {
      if (this.stopped) return;
      await this.checkConnector(connector);
    }
  }

  private async checkBox(): Promise<void> {
    const box = this.opts.box;
    if (!box) {
      this.opts.store.remove(BOX_IMAGE_CAUSE);
      return;
    }
    const [agent, connectors] = await Promise.all([box.status(), box.connectorsStatus()]);
    // Sin runtime no se sabe: no cambia nada.
    if (agent.state === 'unavailable') return;
    const outdated = agent.outdated || connectors.outdated;
    if (!outdated) {
      this.opts.store.remove(BOX_IMAGE_CAUSE);
      return;
    }
    if (this.opts.store.has(BOX_IMAGE_CAUSE)) return;
    const notice: ProtocolHealthNotice = {
      cause: BOX_IMAGE_CAUSE,
      kind: 'degraded',
      area: 'box',
      connector: null,
      text: boxImageText(),
      at: this.opts.now(),
    };
    if (await this.deliver(notice)) this.opts.store.add(BOX_IMAGE_CAUSE, notice.at);
  }

  /** Un conector que ya no está activo (o perdió su comprobación) se olvida sin avisar. */
  private forgetOthers(active: Set<string>): void {
    for (const id of [...this.states.keys()]) {
      if (active.has(id)) continue;
      this.states.delete(id);
      this.results.delete(id);
      this.opts.store.remove(connectorCause(id, 'auth'));
      this.opts.store.remove(connectorCause(id, 'failing'));
    }
  }

  private async checkConnector(c: HealthConnector): Promise<void> {
    let status: AccessStatus;
    let detail: string;
    try {
      const outcome = await this.opts.probe.run(c.id, [{ tool: c.tool, args: {} }]);
      // Sin caja de conectores o sin configurar: no se puede ni mirar, no cambia nada.
      if (outcome.kind === 'suspended') return;
      const first = outcome.outcomes[0];
      if (!first) return;
      if (first.ok) {
        status = accessStatusOf(first.result.estado);
        detail = first.result.detalle;
      } else {
        status = 'error';
        detail = first.reason;
      }
    } catch (err) {
      // No se pudo conectar con el conector: un fallo, nunca `auth`.
      status = 'error';
      detail = messageOf(err);
    }
    const at = this.opts.now();
    this.results.set(c.id, { status, detail, at });
    const prev = this.states.get(c.id) ?? INITIAL_CONNECTOR_HEALTH;
    const step = stepConnectorHealth(prev, status);
    if (!step.notice) {
      this.states.set(c.id, step.state);
      return;
    }
    const notice = this.connectorNotice(c, step.notice, detail, at);
    if (!(await this.deliver(notice))) {
      // Sin entregar no cuenta como avisado: la pasada siguiente lo intenta otra vez.
      this.states.set(c.id, { failures: step.state.failures, notified: prev.notified });
      return;
    }
    this.states.set(c.id, step.state);
    this.opts.store.remove(connectorCause(c.id, 'auth'));
    this.opts.store.remove(connectorCause(c.id, 'failing'));
    if (step.state.notified) this.opts.store.add(connectorCause(c.id, step.state.notified), at);
  }

  private connectorNotice(
    c: HealthConnector,
    kind: ConnectorHealthNotice,
    detail: string,
    at: number,
  ): ProtocolHealthNotice {
    // `recovered` lleva la causa que se resolvió.
    const prev = this.states.get(c.id)?.notified ?? 'failing';
    const cause = connectorCause(c.id, kind === 'recovered' ? prev : kind);
    return {
      cause,
      kind: kind === 'recovered' ? 'recovered' : 'degraded',
      area: 'connectors',
      connector: c.id,
      text: connectorHealthText({
        kind,
        connector: c.id,
        name: c.name,
        ...(kind === 'failing' ? { reason: detail } : {}),
      }),
      at,
    };
  }

  private async deliver(notice: ProtocolHealthNotice): Promise<boolean> {
    try {
      await this.opts.notify(notice);
      // Ni el texto ni el motivo: solo la causa.
      log.info('health notice', { cause: notice.cause, kind: notice.kind });
      return true;
    } catch (err) {
      log.warn('health notice not delivered', { cause: notice.cause, reason: messageOf(err) });
      return false;
    }
  }
}
