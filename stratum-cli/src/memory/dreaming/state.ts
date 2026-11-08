/**
 * M19 fase 5 — estado de *dreaming* (`dreaming.json`, junto a `decisions.json`):
 * qué mensajes de cada conversación ya se revisaron (para que una pasada vea
 * solo lo nuevo) y cuántos tokens se gastaron hoy (el tope diario, B4).
 *
 * Es solo contabilidad: no contiene recuerdos ni texto de conversaciones.
 * Escritura atómica y Zod al leer; uno de un Stratum más nuevo no se toca (y no
 * se hace una pasada: ante la duda, no se gasta).
 */
import { existsSync, readFileSync } from 'fs';
import { z } from 'zod';
import { writeFileAtomic } from '../../config/writer.js';

export const DREAM_STATE_VERSION = 1;

const stateSchema = z.object({
  schemaVersion: z.number().int(),
  /** Día (`YYYY-MM-DD`, UTC) al que se refiere `tokens`. */
  day: z.string(),
  /** Tokens gastados ese día. */
  tokens: z.number().min(0),
  /** Última pasada que terminó (ISO), si la hubo. */
  lastRunAt: z.string().nullable(),
  /** Por sesión: el número del último mensaje (`m<n>`) ya revisado. */
  lastSeen: z.record(z.string(), z.number().int().min(0)),
});
export type DreamState = z.infer<typeof stateSchema>;

export type StateRead =
  | { ok: true; state: DreamState }
  | { ok: false; reason: 'newer' | 'corrupt' };

export const dayOf = (now: Date): string => now.toISOString().slice(0, 10);

export function emptyState(now: Date): DreamState {
  return {
    schemaVersion: DREAM_STATE_VERSION,
    day: dayOf(now),
    tokens: 0,
    lastRunAt: null,
    lastSeen: {},
  };
}

export class DreamStateStore {
  constructor(private readonly file: string) {}

  /** El estado, con los tokens a cero si ya es otro día. */
  read(now: Date = new Date()): StateRead {
    if (!existsSync(this.file)) return { ok: true, state: emptyState(now) };
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.file, 'utf-8'));
    } catch {
      return { ok: false, reason: 'corrupt' };
    }
    const version = (raw as { schemaVersion?: unknown } | null)?.schemaVersion;
    if (typeof version === 'number' && version > DREAM_STATE_VERSION) {
      return { ok: false, reason: 'newer' };
    }
    const parsed = stateSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, reason: 'corrupt' };
    const state = parsed.data;
    return {
      ok: true,
      state: state.day === dayOf(now) ? state : { ...state, day: dayOf(now), tokens: 0 },
    };
  }

  write(state: DreamState): void {
    writeFileAtomic(this.file, JSON.stringify(state, null, 2));
  }
}
