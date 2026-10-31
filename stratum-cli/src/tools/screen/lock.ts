/**
 * M16 — el cerrojo de la pantalla de la caja (PRD de Stratum Dot §23.5): el
 * `companion` principal y las sesiones de rutinas comparten la caja y su única
 * pantalla virtual, y dos runs moviendo el ratón a la vez se pisan. Las
 * acciones (clic, teclas, scroll) toman el cerrojo por sesión; quien llega
 * segundo recibe un error recuperable. Mirar (captura, espera) no lo toma.
 */
import { getLogger } from '../../logging/index.js';

const log = getLogger('screen-lock');

/**
 * Si el que lo tiene no actúa en la pantalla en este tiempo, el cerrojo se
 * puede tomar: red por si un turno se cuelga sin soltarlo (fin de turno y
 * cierre de sesión ya lo sueltan). Holgado a propósito: un modelo lento tarda
 * minutos entre acción y acción y no debe perder la pantalla a media tarea.
 */
export const SCREEN_LEASE_MS = 600_000;

export type ScreenClaim = { ok: true } | { ok: false; holder: string };

export class ScreenLocks {
  private readonly held = new Map<string, { holder: string; lastUsed: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Toma o renueva el cerrojo de la pantalla `box` para `holder`. */
  claim(box: string, holder: string): ScreenClaim {
    const t = this.now();
    const cur = this.held.get(box);
    if (cur && cur.holder !== holder && t - cur.lastUsed <= SCREEN_LEASE_MS) {
      return { ok: false, holder: cur.holder };
    }
    if (cur && cur.holder !== holder) {
      log.info('box screen lock expired, taken over', { box });
    }
    this.held.set(box, { holder, lastUsed: t });
    return { ok: true };
  }

  /** Suelta todo lo que tenga `holder` (fin de turno, cierre de sesión). Idempotente. */
  release(holder: string): void {
    for (const [box, cur] of this.held) {
      if (cur.holder === holder) this.held.delete(box);
    }
  }

  /** Quien tiene la pantalla `box`; `null` si está libre o el lease caducó. */
  holderOf(box: string): string | null {
    const cur = this.held.get(box);
    if (!cur || this.now() - cur.lastUsed > SCREEN_LEASE_MS) return null;
    return cur.holder;
  }
}

/** El del proceso: las sesiones de un daemon comparten caja. */
export const screenLocks = new ScreenLocks();
