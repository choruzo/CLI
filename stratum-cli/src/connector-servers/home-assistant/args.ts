/**
 * Argumentos comunes de las tools de Home Assistant: ids de entidad, la lista
 * metida en un texto, `parseArgs` y el periodo (`horas` | `desde`/`hasta`) que
 * comparten `ha_historial` y `ha_registro`. Aquí y no en `tools.ts` para que los
 * módulos de cada tool (`automations.ts`, `logbook.ts`…) no formen un ciclo.
 */
import { z } from 'zod';
import { ToolUserError } from '../lib/mcp-stdio.js';
import type { HaClient } from './client.js';
import { localTime } from './format.js';
import { localToInstant } from './history.js';
import type { HaWs } from './ws.js';

export const ENTITY_RE = /^[a-z_][a-z0-9_]*\.[a-z0-9_]+$/;
export const ENTITY_MSG = 'entity_id debe tener la forma dominio.nombre (p. ej. light.salon)';

export const entityId = z.string({ message: ENTITY_MSG }).trim().regex(ENTITY_RE, ENTITY_MSG);

/**
 * Algunos modelos mandan la lista metida en un texto: `"[\"light.a\", \"light.b\"]"`
 * o `"light.a, light.b"` (medido el 2026-11-18 desde Dot). Se convierte en la
 * lista que es; cada id se valida después igual. Un texto que no es ninguna de
 * las dos formas se queda como está y lo rechaza la regex.
 */
export function listFromText(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  const t = v.trim();
  if (t.startsWith('[') && t.endsWith(']')) {
    try {
      const parsed: unknown = JSON.parse(t);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // No es JSON: lo rechaza la validación con su mensaje.
    }
    return v;
  }
  if (t.includes(',')) return t.split(',').map((s) => s.trim());
  return v;
}

export function entityIds(max: number) {
  const msg = `entity_id debe ser un id o una lista de hasta ${max} ids con la forma dominio.nombre`;
  return z
    .unknown()
    .transform(listFromText)
    .pipe(z.union([entityId, z.array(entityId).min(1, msg).max(max, msg)], { message: msg }));
}

export function parseArgs<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, args: unknown): T {
  const r = schema.safeParse(args ?? {});
  if (r.success) return r.data;
  const issue = r.error.issues[0];
  throw new ToolUserError(`Argumento inválido: ${issue?.message ?? 'argumentos no válidos'}.`);
}

export function idList(v: string | string[]): string[] {
  return [...new Set(typeof v === 'string' ? [v] : v)];
}

// --- Periodo -----------------------------------------------------------------

/** Historial y registro (M22 parte 4, M27): periodo acotado a 7 días. */
export const MAX_HISTORY_HOURS = 168;
export const DEFAULT_HISTORY_HOURS = 24;

const HOURS_MSG = `horas debe ser un entero entre 1 y ${MAX_HISTORY_HOURS} (7 días)`;
export const LOCAL_MSG = (f: string): string =>
  `${f} debe ser una fecha AAAA-MM-DD o una fecha y hora AAAA-MM-DDTHH:MM en hora de la casa`;
const localWhen = (f: string) =>
  z
    .string({ message: LOCAL_MSG(f) })
    .trim()
    .max(16, LOCAL_MSG(f))
    .optional();

/** Campos de zod del periodo, para meterlos en el esquema de cada tool. */
export const periodFields = {
  horas: z
    .number({ message: HOURS_MSG })
    .int(HOURS_MSG)
    .min(1, HOURS_MSG)
    .max(MAX_HISTORY_HOURS, HOURS_MSG)
    .optional(),
  desde: localWhen('desde'),
  hasta: localWhen('hasta'),
};

export interface PeriodArgs {
  horas?: number | undefined;
  desde?: string | undefined;
  hasta?: string | undefined;
}

export interface Period {
  start: number;
  end: number;
  /** El periodo acaba ahora (no en un `hasta` pasado). */
  toNow: boolean;
  label: string;
}

/** Las combinaciones que no valen, antes de consultar nada. */
export function assertPeriodArgs(a: PeriodArgs): void {
  if (a.desde !== undefined && a.horas !== undefined) {
    throw new ToolUserError(
      'Argumento inválido: usa horas (las últimas N horas) o desde/hasta (un periodo concreto), no los dos.',
    );
  }
  if (a.hasta !== undefined && a.desde === undefined) {
    throw new ToolUserError('Argumento inválido: hasta necesita desde.');
  }
}

/** El periodo pedido, en ms, con su descripción. `tz` es la zona de la casa. */
export function resolvePeriod(a: PeriodArgs, tz: string | null, current: number): Period {
  const at = (ms: number): string => localTime(new Date(ms).toISOString(), tz);
  if (a.desde === undefined) {
    const hours = a.horas ?? DEFAULT_HISTORY_HOURS;
    return {
      start: current - hours * 3_600_000,
      end: current,
      toNow: true,
      label: `las últimas ${hours} h`,
    };
  }
  const from = localToInstant(a.desde, tz);
  if (from === null) throw new ToolUserError(`Argumento inválido: ${LOCAL_MSG('desde')}.`);
  const to = a.hasta === undefined ? current : localToInstant(a.hasta, tz, true);
  if (to === null) throw new ToolUserError(`Argumento inválido: ${LOCAL_MSG('hasta')}.`);
  if (from >= current) {
    throw new ToolUserError(
      `Argumento inválido: desde (${at(from)}) es posterior a ahora (${at(current)}): no hay historial del futuro.`,
    );
  }
  if (to <= from) {
    throw new ToolUserError('Argumento inválido: hasta tiene que ser posterior a desde.');
  }
  if (to - from > MAX_HISTORY_HOURS * 3_600_000) {
    throw new ToolUserError(
      'Argumento inválido: el periodo de desde a hasta admite como máximo 7 días.',
    );
  }
  // Lo que pase de ahora se recorta: el periodo acaba ahora.
  const end = Math.min(to, current);
  const toNow = to >= current;
  return {
    start: from,
    end,
    toNow,
    label: `el periodo de ${at(from)} a ${toNow ? `ahora (${at(end)})` : at(end)}`,
  };
}

/** Un instante como parámetro de URL (ISO, escapado). */
export function isoParam(ms: number): string {
  return encodeURIComponent(new Date(ms).toISOString());
}

/** Lo que `tools.ts` da a los módulos de cada tool nueva (M27): sin ciclos de imports. */
export interface HaToolContext {
  /** El cliente REST, o `notConfigured()` si falta la URL o el token. */
  need(): HaClient;
  /** El cliente WebSocket (solo lectura); `what` dice qué no se podría leer sin él. */
  needWs(what: string): HaWs;
  now(): number;
}
