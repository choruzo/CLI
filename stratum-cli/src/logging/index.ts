/**
 * Punto de entrada del sistema de logs.
 *
 *   import { getLogger } from '../logging/index.js';
 *   const log = getLogger('provider');
 *   log.debug('request', { model, messages: n });
 *
 * `configureLogging(config, overrides)` se llama una vez al arrancar cada
 * comando (chat/run). Antes de configurarse, el umbral global es `silent`, así
 * que cualquier `log.*` capturado a nivel de módulo es un no-op seguro.
 */

import { join } from 'path';
import { expandHome } from '../config/paths.js';
import type { StratumConfig } from '../config/schema.js';
import { Logger, LoggerCore } from './logger.js';
import { FileSink, StderrSink } from './sinks.js';
import { isLogLevel, type LogLevel, type LogSink } from './types.js';

export { Logger, LoggerCore } from './logger.js';
export { StderrSink, FileSink, MemorySink } from './sinks.js';
export * from './types.js';
export { redact, redactFields } from './redact.js';

// Núcleo singleton compartido por todos los loggers del proceso.
const core = new LoggerCore();

/** Logger raíz (namespace vacío). */
export const rootLogger = new Logger(core, '');

/** Devuelve un logger para el namespace dado (p. ej. `agent.loop`). */
export function getLogger(ns?: string): Logger {
  return ns ? rootLogger.child(ns) : rootLogger;
}

/** Vacía los buffers de todos los sinks (llamar antes de salir del proceso). */
export function flushLogging(): Promise<void> {
  return core.flush();
}

/** Cierra todos los sinks liberando recursos. */
export function closeLogging(): Promise<void> {
  return core.close();
}

// ---------------------------------------------------------------------------
// Configuración
// ---------------------------------------------------------------------------

export interface LoggingOverrides {
  /** De `--log-level`. */
  level?: LogLevel;
  /** De `--debug`: sube a `debug` y activa el fichero. */
  debug?: boolean;
  /** Forzar activación/desactivación del sink de stderr. */
  stderrEnabled?: boolean;
  /** Nivel propio del sink de stderr (chat lo sube a `warn` para no ensuciar Ink). */
  stderrLevel?: LogLevel;
  /** Forzar activación/desactivación del sink de fichero. */
  fileEnabled?: boolean;
  /** Stream alternativo para el sink de stderr (tests). */
  stderrStream?: { write(s: string): void; isTTY?: boolean };
}

let resolvedFilePath: string | null = null;

/** Valores por defecto del bloque `logging` (espejo del schema Zod). Se usan
 * cuando el `config` recibido no trae el bloque completo (p. ej. configs
 * parciales construidos a mano en tests). */
const LOGGING_DEFAULTS = {
  level: 'info' as LogLevel,
  stderr: true,
  redact: true,
  file: {
    enabled: false,
    dir: '~/.stratum/logs',
    maxBytes: 5 * 1024 * 1024,
    maxFiles: 5,
  },
};

/** Normaliza el bloque `logging`, rellenando lo que falte con los defaults. */
function resolveLoggingConfig(config: StratumConfig): typeof LOGGING_DEFAULTS {
  const lg = (config as Partial<StratumConfig>).logging;
  if (!lg) return LOGGING_DEFAULTS;
  return {
    level: lg.level ?? LOGGING_DEFAULTS.level,
    stderr: lg.stderr ?? LOGGING_DEFAULTS.stderr,
    redact: lg.redact ?? LOGGING_DEFAULTS.redact,
    file: { ...LOGGING_DEFAULTS.file, ...lg.file },
  };
}

/** Ruta absoluta del fichero de logs según la config (sin activarlo). */
export function logFilePath(config: StratumConfig): string {
  return join(expandHome(resolveLoggingConfig(config).file.dir), 'stratum.jsonl');
}

/** Última ruta de fichero activada por `configureLogging`, o `null`. */
export function activeLogFilePath(): string | null {
  return resolvedFilePath;
}

function envBool(name: string): boolean | undefined {
  const v = process.env[name];
  if (v === undefined || v === '') return undefined;
  return v === '1' || v.toLowerCase() === 'true';
}

/**
 * Configura los sinks del logger a partir de la config y de overrides de
 * CLI/env. Precedencia (de mayor a menor): flags > variables de entorno >
 * `.stratumrc.json`.
 *
 * Variables de entorno:
 *   - `STRATUM_LOG_LEVEL`  nivel base (trace|debug|info|warn|error|silent)
 *   - `STRATUM_DEBUG=1`    equivale a `--debug` (nivel debug + fichero)
 *   - `STRATUM_LOG_FILE`   `1`/`0` activa o desactiva el sink de fichero
 */
export function configureLogging(config: StratumConfig, overrides: LoggingOverrides = {}): void {
  const lg = resolveLoggingConfig(config);

  const envLevel = process.env['STRATUM_LOG_LEVEL'];
  const debugMode = overrides.debug === true || envBool('STRATUM_DEBUG') === true;

  const baseLevel: LogLevel =
    overrides.level ??
    (envLevel && isLogLevel(envLevel) ? envLevel : undefined) ??
    (debugMode ? 'debug' : lg.level);

  const sinks: LogSink[] = [];

  // -- stderr (legible) -----------------------------------------------------
  const stderrEnabled = overrides.stderrEnabled ?? lg.stderr;
  if (stderrEnabled && baseLevel !== 'silent') {
    const stderrLevel: LogLevel =
      overrides.level || debugMode ? baseLevel : (overrides.stderrLevel ?? baseLevel);
    sinks.push(new StderrSink({ level: stderrLevel, stream: overrides.stderrStream }));
  }

  // -- fichero (JSONL) ------------------------------------------------------
  const fileEnabled =
    overrides.fileEnabled ?? envBool('STRATUM_LOG_FILE') ?? (debugMode ? true : lg.file.enabled);
  if (fileEnabled && baseLevel !== 'silent') {
    resolvedFilePath = logFilePath(config);
    sinks.push(
      new FileSink({
        path: resolvedFilePath,
        level: baseLevel,
        maxBytes: lg.file.maxBytes,
        maxFiles: lg.file.maxFiles,
      }),
    );
  } else {
    resolvedFilePath = null;
  }

  core.setSinks(sinks, lg.redact);
}

/** Reinicia el logger a estado silencioso (tests). */
export function resetLogging(sinks: LogSink[] = [], redact = true): void {
  resolvedFilePath = null;
  core.setSinks(sinks, redact);
}
