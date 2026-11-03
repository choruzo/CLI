/**
 * M17 — concesiones con caducidad de **una** sesión («permitir 10 minutos»).
 *
 * Una concesión es la tercera respuesta a una aprobación, entre «una vez» y el
 * `allow-all` de sesión: durante 10, 30 o 60 minutos, el dispatcher no vuelve a
 * preguntar por esa pareja tool + target (sin target, por la tool).
 *
 *  - **Vive aquí, en memoria del anfitrión**, junto a `PendingInteractions`: no
 *    se guarda en disco, no sobrevive a un reinicio y no viaja en un traspaso
 *    (el DTO de M10 no lleva autoridad).
 *  - **La caducidad la decide un reloj monotónico**, comprobado en cada
 *    consulta: cambiar la hora del sistema no la alarga. El temporizador solo
 *    avisa a quien escucha (el publicador); quien manda es `match`.
 *  - **Solo se crea al resolver una aprobación** que lo admite (`grantable`, lo
 *    decide el dispatcher): nunca una forzada, con frase ni en una rutina.
 *    Revocar solo resta.
 */
import { randomBytes } from 'crypto';
import { getLogger } from '../logging/index.js';
import type { ApprovalGrantLookup, GrantMatch } from '../agent/types.js';
import type {
  ProtocolApprovalGrant,
  ProtocolGrantMinutes,
  ProtocolResolver,
} from '../protocol/index.js';

const log = getLogger('host').child('grants');

export type GrantChange =
  | { type: 'created'; grant: ProtocolApprovalGrant }
  | { type: 'ended'; grant: ProtocolApprovalGrant; reason: 'expired' | 'revoked' };

export interface ApprovalGrantsOptions {
  /** `false`: la sesión no admite concesiones (la de una rutina). */
  enabled?: boolean;
  /** Reloj de pared, solo para lo que se enseña (`grantedAt`/`expiresAt`). */
  now?: () => number;
  /** Reloj monotónico en ms: el que decide la caducidad. */
  monotonic?: () => number;
}

interface Entry {
  grant: ProtocolApprovalGrant;
  /** En el reloj monotónico. */
  deadline: number;
  timer: NodeJS.Timeout | null;
}

function newId(): string {
  return `grt_${randomBytes(8).toString('hex')}`;
}

/** La pareja que cubre una concesión. `target` ausente = la tool entera. */
function scopeKey(tool: string, target: string | undefined): string {
  return target === undefined ? `${tool}\u0000` : `${tool}\u0000${target}`;
}

export class ApprovalGrants implements ApprovalGrantLookup {
  readonly enabled: boolean;
  private readonly now: () => number;
  private readonly monotonic: () => number;
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<(change: GrantChange) => void>();

  constructor(
    private readonly sessionId: string,
    opts: ApprovalGrantsOptions = {},
  ) {
    this.enabled = opts.enabled ?? true;
    this.now = opts.now ?? Date.now;
    this.monotonic = opts.monotonic ?? (() => performance.now());
  }

  subscribe(listener: (change: GrantChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(change: GrantChange): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(change);
      } catch (err) {
        log.error('grant listener failed', { err });
      }
    }
  }

  /**
   * Abre una concesión para esa pareja. Si ya había una, la sustituye (con id
   * nuevo): renovar es empezar a contar otra vez, nunca sumar.
   *
   * @throws Error si la sesión no admite concesiones: quien llama ya lo validó,
   *   y llegar aquí sin poder es un fallo de cableado, no una decisión.
   */
  create(
    scope: { tool: string; target?: string },
    minutes: ProtocolGrantMinutes,
    by: ProtocolResolver,
  ): ProtocolApprovalGrant {
    if (!this.enabled) throw new Error('approval grants are disabled in this session');
    const key = scopeKey(scope.tool, scope.target);
    const previous = this.entries.get(key);
    if (previous?.timer) clearTimeout(previous.timer);

    const ms = minutes * 60_000;
    const grantedAt = this.now();
    const grant: ProtocolApprovalGrant = {
      id: newId(),
      sessionId: this.sessionId,
      tool: scope.tool,
      ...(scope.target !== undefined ? { target: scope.target } : {}),
      minutes,
      grantedAt,
      expiresAt: grantedAt + ms,
      grantedBy: by,
    };
    const entry: Entry = { grant, deadline: this.monotonic() + ms, timer: null };
    entry.timer = setTimeout(() => this.expire(key, entry), ms);
    entry.timer.unref();
    this.entries.set(key, entry);
    log.info('grant created', {
      sessionId: this.sessionId,
      grantId: grant.id,
      tool: grant.tool,
      ...(grant.target !== undefined ? { target: grant.target } : {}),
      minutes,
      by: by.kind,
      ...(by.connectionId !== undefined ? { connectionId: by.connectionId } : {}),
    });
    this.notify({ type: 'created', grant: { ...grant } });
    return { ...grant };
  }

  /**
   * La concesión vigente que cubre esa pareja, o `null`. Una caducada se retira
   * aquí mismo, aunque su temporizador no haya saltado aún.
   */
  match(tool: string, target: string | undefined): GrantMatch | null {
    if (!this.enabled) return null;
    const key = scopeKey(tool, target);
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (this.monotonic() >= entry.deadline) {
      this.expire(key, entry);
      return null;
    }
    const { id, minutes, expiresAt } = entry.grant;
    return { id, minutes, expiresAt };
  }

  /** Concesiones vigentes, de la más antigua a la más reciente. */
  list(): ProtocolApprovalGrant[] {
    const at = this.monotonic();
    for (const [key, entry] of [...this.entries]) {
      if (at >= entry.deadline) this.expire(key, entry);
    }
    return [...this.entries.values()].map((e) => ({ ...e.grant }));
  }

  /** Retira una concesión. `null` si ya no estaba (caducó o se revocó). */
  revoke(grantId: string): ProtocolApprovalGrant | null {
    for (const [key, entry] of this.entries) {
      if (entry.grant.id !== grantId) continue;
      if (this.monotonic() >= entry.deadline) {
        this.expire(key, entry);
        return null;
      }
      this.end(key, entry, 'revoked');
      return { ...entry.grant };
    }
    return null;
  }

  /** Cierre de la sesión: todo se retira sin avisar (la sesión ya no publica). */
  clear(): void {
    for (const entry of this.entries.values()) if (entry.timer) clearTimeout(entry.timer);
    this.entries.clear();
  }

  private expire(key: string, entry: Entry): void {
    this.end(key, entry, 'expired');
  }

  private end(key: string, entry: Entry, reason: 'expired' | 'revoked'): void {
    // Solo la entrada vigente: el temporizador de una ya sustituida no cuenta.
    if (this.entries.get(key) !== entry) return;
    this.entries.delete(key);
    if (entry.timer) clearTimeout(entry.timer);
    log.info('grant ended', { sessionId: this.sessionId, grantId: entry.grant.id, reason });
    this.notify({ type: 'ended', grant: { ...entry.grant }, reason });
  }
}
