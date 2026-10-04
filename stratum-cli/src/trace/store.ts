import { existsSync, readdirSync, statSync, unlinkSync } from 'fs';
import { join } from 'path';
import type { StratumConfig } from '../config/schema.js';
import { expandHome } from '../config/paths.js';
import { TraceRecorder } from './recorder.js';

/**
 * Ficheros de traza en disco: `<trace.dir>/<sessionId>.jsonl`. Son derivados
 * (la conversación vive en la sesión), así que todo aquí es best-effort y
 * nunca lanza.
 */

const TRACE_EXT = '.jsonl';
/** El id acaba en una ruta: solo lo que no puede salir del directorio. */
const TRACE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export function isTraceId(id: string): boolean {
  return TRACE_ID_RE.test(id);
}

export function traceDir(config: StratumConfig): string {
  return expandHome(config.trace.dir);
}

/** Ruta de la traza de una sesión, o null si el id no sirve como nombre de fichero. */
export function traceFilePath(config: StratumConfig, sessionId: string): string | null {
  return isTraceId(sessionId) ? join(traceDir(config), sessionId + TRACE_EXT) : null;
}

/** Recorder de la sesión, o null con la traza desactivada o un id inservible. */
export function openSessionTrace(
  config: StratumConfig,
  sessionId: string,
  meta?: { cwd?: string; version?: string },
): TraceRecorder | null {
  // Una config montada a mano sin la sección (tests) no graba: nunca se escribe
  // en el home real por omisión de quien la construyó.
  const trace = (config as Partial<StratumConfig>).trace;
  if (!trace?.enabled) return null;
  const file = traceFilePath(config, sessionId);
  return file ? new TraceRecorder({ file, sessionId, config, ...meta }) : null;
}

export interface TraceFileInfo {
  sessionId: string;
  file: string;
  updatedAt: number;
  bytes: number;
}

/** Trazas guardadas, la más reciente primero. */
export function listTraces(config: StratumConfig): TraceFileInfo[] {
  const dir = traceDir(config);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: TraceFileInfo[] = [];
  for (const name of names) {
    if (!name.endsWith(TRACE_EXT)) continue;
    const sessionId = name.slice(0, -TRACE_EXT.length);
    if (!isTraceId(sessionId)) continue;
    const file = join(dir, name);
    try {
      const st = statSync(file);
      if (st.isFile()) out.push({ sessionId, file, updatedAt: st.mtimeMs, bytes: st.size });
    } catch {
      /* desapareció entre el listado y el stat */
    }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function deleteTrace(config: StratumConfig, sessionId: string): boolean {
  const file = traceFilePath(config, sessionId);
  if (!file || !existsSync(file)) return false;
  try {
    unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

/** Borra las trazas sin tocar desde hace más de `olderThanMs`. Devuelve cuántas. */
export function pruneTraces(config: StratumConfig, olderThanMs: number, now = Date.now()): number {
  let removed = 0;
  for (const t of listTraces(config)) {
    if (now - t.updatedAt <= olderThanMs) continue;
    try {
      unlinkSync(t.file);
      removed++;
    } catch {
      /* en uso o sin permisos: se intentará en el siguiente arranque */
    }
  }
  return removed;
}
