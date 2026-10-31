/**
 * M16 — `routines.*`: de `RoutineStatus` al DTO del protocolo, del parche del
 * protocolo al `RoutinePatch` del almacén, y los errores del almacén traducidos.
 * Nada aquí loguea: el `prompt` es la definición de la persona y no va a los logs.
 */
import { ProtocolError } from '../ipc/codec.js';
import type {
  ProtocolRoutine,
  ProtocolRoutineFire,
  ProtocolRoutineLimits,
} from '../protocol/index.js';
import { RoutineStoreError, type RoutinePatch } from '../routines/store.js';
import type { RoutineFire, RoutineStatus } from './routine-scheduler.js';

export function toProtocolFire(fire: RoutineFire): ProtocolRoutineFire {
  return {
    at: fire.at,
    outcome: fire.outcome,
    manual: fire.manual,
    ...(fire.sessionId ? { sessionId: fire.sessionId } : {}),
    ...(fire.runId ? { runId: fire.runId } : {}),
    ...(fire.error ? { error: fire.error } : {}),
  };
}

export function toProtocolRoutine(status: RoutineStatus): ProtocolRoutine {
  const r = status.routine;
  const created = Date.parse(r.createdAt);
  return {
    id: r.id,
    name: r.name,
    schedule: r.schedule,
    prompt: r.prompt,
    ...(r.model ? { model: r.model } : {}),
    enabled: r.enabled,
    ...(r.limits ? { limits: r.limits } : {}),
    // `createdAt` del almacén es ISO; el protocolo, ms. Ilegible → 0 (no se inventa).
    createdAt: Number.isNaN(created) ? 0 : created,
    nextFireAt: status.nextFireAt,
    scheduleError: status.scheduleError,
    sessionId: status.sessionId,
    running: status.running,
    lastFire: status.lastFire ? toProtocolFire(status.lastFire) : null,
    lastResult: status.lastResult ? { ...status.lastResult } : null,
  };
}

/** `null` quita `model`/`limits` (el almacén los quita si la clave está con valor vacío). */
export function toRoutinePatch(patch: {
  name?: string;
  schedule?: string;
  prompt?: string;
  model?: string | null;
  enabled?: boolean;
  limits?: ProtocolRoutineLimits | null;
}): RoutinePatch {
  const out: RoutinePatch = {};
  if (patch.name !== undefined) out.name = patch.name;
  if (patch.schedule !== undefined) out.schedule = patch.schedule;
  if (patch.prompt !== undefined) out.prompt = patch.prompt;
  if (patch.enabled !== undefined) out.enabled = patch.enabled;
  if (patch.model !== undefined) out.model = patch.model ?? undefined;
  if (patch.limits !== undefined) out.limits = patch.limits ?? undefined;
  return out;
}

/** Ejecuta una operación del planificador con los errores del almacén como errores del protocolo. */
export async function routineOperation<T>(fn: () => T | Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!(err instanceof RoutineStoreError)) throw err;
    switch (err.code) {
      case 'not-found':
        throw new ProtocolError('NOT_FOUND', 'Routine not found.');
      case 'read-only':
        throw new ProtocolError('UNAVAILABLE', err.message, { reason: 'read-only' });
      case 'duplicate-name':
        throw new ProtocolError('INVALID_PARAMS', err.message, {
          issues: [{ path: 'name', message: err.message }],
        });
      case 'invalid': {
        // El almacén dice «Invalid <campo>: …»; sin campo, la rutina entera.
        const path = /^Invalid ([A-Za-z.]+):/.exec(err.message)?.[1] ?? 'routine';
        throw new ProtocolError('INVALID_PARAMS', err.message, {
          issues: [{ path, message: err.message }],
        });
      }
    }
  }
}
