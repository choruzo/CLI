import { getLogger } from '../logging/index.js';
import type { WorkspaceManager, WorkspaceSettings } from './workspace.js';

/**
 * Retención de workspaces (Stratum Desktop D3): el janitor del sidecar.
 *
 * Se ejecuta al arrancar y cada 24 h mientras la app está abierta; nunca hay
 * nada en segundo plano con la app cerrada, así que el primer pase tras un
 * arranque recupera el retraso. Cada pase:
 *
 * 1. `recover()`: barre temporales y restos de operaciones interrumpidas.
 * 2. Para cada conversación con algo en la raíz, con su lock (16.5), aplica
 *    `retentionAction`. Salta las abiertas en el host —con turno en curso o
 *    solo a la vista en la UI— y las fijadas (16.7).
 *
 * Un fallo en una conversación se registra y no para el pase.
 */

const log = getLogger('desktop.retention');

export const JANITOR_INTERVAL_MS = 24 * 60 * 60 * 1000;

export type RetentionAction = 'none' | 'archive' | 'purge';

/**
 * Qué toca hacer con un workspace. Puro. Uno activo que ya superó el plazo de
 * purga se purga directamente, sin comprimirlo antes.
 */
export function retentionAction(
  state: 'active' | 'archived' | 'purged',
  fields: { lastUsedAt: string; pinned: boolean },
  now: Date,
  settings: Pick<WorkspaceSettings, 'compressAfterMs' | 'deleteAfterMs'>,
): RetentionAction {
  if (fields.pinned || state === 'purged') return 'none';
  const last = Date.parse(fields.lastUsedAt);
  if (Number.isNaN(last)) return 'none';
  const idle = now.getTime() - last;
  const deleteAfter = settings.deleteAfterMs ?? 0;
  const compressAfter = settings.compressAfterMs ?? 0;
  if (deleteAfter > 0 && idle >= deleteAfter) return 'purge';
  if (state === 'active' && compressAfter > 0 && idle >= compressAfter) return 'archive';
  return 'none';
}

export interface JanitorReport {
  archived: string[];
  purged: string[];
  /** Abiertas en el host durante el pase. */
  inUse: string[];
  failed: Array<{ conversationId: string; error: string }>;
}

export interface JanitorOptions {
  intervalMs?: number;
  now?: () => Date;
}

export class WorkspaceJanitor {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<JanitorReport> | null = null;
  private stopped = false;
  private readonly intervalMs: number;
  private readonly now: () => Date;

  constructor(
    private readonly manager: WorkspaceManager,
    opts: JanitorOptions = {},
  ) {
    this.intervalMs = opts.intervalMs ?? JANITOR_INTERVAL_MS;
    this.now = opts.now ?? (() => new Date());
  }

  /** ¿Hay alguna etapa activa? Sin ninguna, el janitor no arranca. */
  get enabled(): boolean {
    const s = this.manager.settings;
    return (s.compressAfterMs ?? 0) > 0 || (s.deleteAfterMs ?? 0) > 0;
  }

  /** Primer pase ya y luego cada `intervalMs`. El temporizador no retiene el proceso. */
  start(): void {
    if (!this.enabled || this.timer || this.stopped) return;
    void this.runOnce();
    this.timer = setInterval(() => void this.runOnce(), this.intervalMs);
    this.timer.unref();
  }

  /**
   * Los plazos cambiaron desde Ajustes (D5): arranca si se acaba de activar
   * alguna etapa y deja de programar pases si ya no queda ninguna.
   */
  refresh(): void {
    if (this.stopped) return;
    if (this.enabled) {
      this.start();
    } else if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Deja de programar pases y no empieza operaciones nuevas. No espera a la
   * que esté en marcha: morir a mitad es seguro (lo recoge `recover`).
   */
  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Un pase. Si ya hay uno en marcha, devuelve ese. */
  runOnce(): Promise<JanitorReport> {
    this.running ??= this.pass().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async pass(): Promise<JanitorReport> {
    const report: JanitorReport = { archived: [], purged: [], inUse: [], failed: [] };
    const started = Date.now();
    await this.manager.recover();
    for (const id of this.manager.list()) {
      if (this.stopped) break;
      if (this.manager.isInUse(id)) {
        report.inUse.push(id);
        continue;
      }
      try {
        await this.manager.withLock(id, async () => {
          // Otra vez con el lock: la conversación pudo abrirse mientras esperábamos.
          if (this.manager.isInUse(id) || this.stopped) return;
          const found = this.manager.inspect(id);
          if (found.state === 'none') return;
          const fields = found.state === 'active' ? found.meta : found.record;
          if (!fields) return; // sin metadatos válidos: no se data, no se toca
          const action = retentionAction(found.state, fields, this.now(), this.manager.settings);
          if (action === 'archive') {
            await this.manager.archive(id);
            report.archived.push(id);
          } else if (action === 'purge') {
            await this.manager.purge(id);
            report.purged.push(id);
          }
        });
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        log.warn('retention step failed', { conversationId: id, error });
        report.failed.push({ conversationId: id, error });
      }
    }
    log.info('retention pass', {
      archived: report.archived.length,
      purged: report.purged.length,
      inUse: report.inUse.length,
      failed: report.failed.length,
      ms: Date.now() - started,
    });
    return report;
  }
}
