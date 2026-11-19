/**
 * M22 — `watches.*`: un vigilante guardado como va por el protocolo, las
 * comprobaciones del catálogo y los errores del almacén traducidos
 * (`docs/protocol.md` §31).
 *
 * Nada aquí loguea: el nombre y los argumentos de un vigilante los escribió la
 * persona (o el agente) y no van a los logs.
 */
import { ProtocolError } from '../ipc/codec.js';
import { checksOf, type ConnectorManifest } from '../connectors/manifest.js';
import type { ProtocolWatch, ProtocolWatchCheck } from '../protocol/index.js';
import { WatchStoreError, type StoredWatch } from '../watches/store.js';

/** Lo guardado, sin el estado interno: solo lo que se deriva de él. */
export function toProtocolWatch(w: StoredWatch): ProtocolWatch {
  return {
    id: w.id,
    name: w.name,
    connector: w.connector,
    check: w.check,
    args: { ...w.args },
    condition: structuredClone(w.condition),
    intervalSec: w.intervalSec,
    cooldownMinutes: w.cooldownMinutes,
    notifyResolved: w.notifyResolved,
    status: w.status,
    origin: w.origin,
    createdAt: w.createdAt,
    firing: w.state.firing,
    lastFiredAt: w.state.lastFiredAt,
    health: w.state.suspendedNotified ? 'suspended' : w.state.failingNotified ? 'failing' : 'ok',
    ...(w.routineId ? { routineId: w.routineId } : {}),
  };
}

/** Las comprobaciones de todo el catálogo, con si su conector está activo. */
export function toProtocolWatchChecks(
  manifests: readonly ConnectorManifest[],
  enabled: ReadonlySet<string>,
): ProtocolWatchCheck[] {
  return manifests.flatMap((m) =>
    checksOf(m).map((c) => ({
      connector: m.id,
      connectorName: m.name,
      connectorEnabled: enabled.has(m.id),
      tool: c.tool,
      summary: c.summary,
      minIntervalSec: c.minIntervalSec,
      args: c.args.map((a) => ({
        name: a.name,
        type: a.type,
        required: a.required,
        description: a.description,
        ...(a.enum ? { enum: [...a.enum] } : {}),
        ...(a.minimum !== undefined ? { minimum: a.minimum } : {}),
        ...(a.maximum !== undefined ? { maximum: a.maximum } : {}),
      })),
    })),
  );
}

/** Ejecuta una operación del planificador con los errores del almacén como errores del protocolo. */
export async function watchOperation<T>(fn: () => T | Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!(err instanceof WatchStoreError)) throw err;
    switch (err.code) {
      case 'not-found':
        throw new ProtocolError('NOT_FOUND', 'Watch not found.');
      case 'read-only':
        throw new ProtocolError('UNAVAILABLE', err.message, { reason: 'read-only' });
      case 'invalid':
        throw new ProtocolError('INVALID_PARAMS', err.message, {
          issues: [{ path: 'watch', message: err.message }],
        });
    }
  }
}

/** Un vigilante que no vale (`defineWatch`), como error del protocolo. */
export function invalidWatch(message: string): ProtocolError {
  // `defineWatch` dice «Invalid <qué> (<campo>): …» o nombra el argumento.
  const path = /^Invalid (?:watch|condition) \(([A-Za-z0-9_.]+)\)/.exec(message)?.[1];
  return new ProtocolError('INVALID_PARAMS', message, {
    issues: [{ path: path ?? 'watch', message }],
  });
}
