/**
 * Logger de Stratum.
 *
 * Un `Logger` está ligado a un `LoggerCore` compartido y mutable: los sinks y
 * el umbral global se configuran una sola vez (vía `configureLogging`), de modo
 * que un `const log = getLogger('provider')` capturado a nivel de módulo sigue
 * funcionando después de la configuración. Los loggers hijo (`child`) heredan
 * namespace y campos base.
 */

import { redactFields } from './redact.js';
import {
  LEVEL_ORDER,
  type EmitLevel,
  type LogLevel,
  type LogRecord,
  type LogSink,
  type SerializedError,
} from './types.js';

/** Estado compartido entre todos los loggers. Mutado por `configureLogging`. */
export class LoggerCore {
  sinks: LogSink[] = [];
  /** Umbral global: el menor de los niveles de los sinks activos. */
  gate: LogLevel = 'silent';
  /** Si la redacción de secretos está activa. */
  redact = true;

  setSinks(sinks: LogSink[], redact: boolean): void {
    this.sinks = sinks;
    this.redact = redact;
    this.gate = sinks.length
      ? sinks.reduce<LogLevel>(
          (min, s) => (LEVEL_ORDER[s.level] < LEVEL_ORDER[min] ? s.level : min),
          'silent',
        )
      : 'silent';
  }

  enabled(level: EmitLevel): boolean {
    return LEVEL_ORDER[level] >= LEVEL_ORDER[this.gate];
  }

  emit(record: LogRecord): void {
    for (const sink of this.sinks) {
      if (LEVEL_ORDER[record.level] >= LEVEL_ORDER[sink.level]) {
        sink.write(record);
      }
    }
  }

  async flush(): Promise<void> {
    await Promise.allSettled(this.sinks.map((s) => s.flush?.()));
  }

  async close(): Promise<void> {
    await Promise.allSettled(this.sinks.map((s) => s.close?.()));
  }
}

function serializeError(err: unknown): SerializedError {
  if (err instanceof Error) {
    return { name: err.name, message: err.message, stack: err.stack };
  }
  return { name: 'Error', message: String(err) };
}

/** Campos de log; `err` recibe un trato especial (se serializa aparte). */
export type LogFields = Record<string, unknown> & { err?: unknown };

export class Logger {
  constructor(
    private readonly core: LoggerCore,
    private readonly ns: string,
    private readonly baseFields?: Record<string, unknown>,
  ) {}

  /** Crea un logger hijo con namespace anidado (`padre.hijo`) y campos heredados. */
  child(ns: string, fields?: Record<string, unknown>): Logger {
    const childNs = this.ns ? `${this.ns}.${ns}` : ns;
    const merged =
      this.baseFields || fields ? { ...this.baseFields, ...fields } : undefined;
    return new Logger(this.core, childNs, merged);
  }

  trace(msg: string, fields?: LogFields): void {
    this.log('trace', msg, fields);
  }
  debug(msg: string, fields?: LogFields): void {
    this.log('debug', msg, fields);
  }
  info(msg: string, fields?: LogFields): void {
    this.log('info', msg, fields);
  }
  warn(msg: string, fields?: LogFields): void {
    this.log('warn', msg, fields);
  }
  error(msg: string, fields?: LogFields): void {
    this.log('error', msg, fields);
  }

  /**
   * Inicia un cronómetro de alta resolución. Devuelve una función que, al
   * llamarse, retorna los ms transcurridos. Útil para medir latencias:
   *   const end = log.startTimer();
   *   ...
   *   log.debug('llm done', { durationMs: end() });
   */
  startTimer(): () => number {
    const t0 = performance.now();
    return () => Math.round((performance.now() - t0) * 100) / 100;
  }

  private log(level: EmitLevel, msg: string, fields?: LogFields): void {
    if (!this.core.enabled(level)) return;

    let err: SerializedError | undefined;
    let rest: Record<string, unknown> | undefined;

    if (fields) {
      const { err: rawErr, ...others } = fields;
      if (rawErr !== undefined) err = serializeError(rawErr);
      if (Object.keys(others).length > 0) rest = others;
    }

    const combined =
      this.baseFields || rest ? { ...this.baseFields, ...rest } : undefined;

    this.core.emit({
      time: new Date().toISOString(),
      level,
      ns: this.ns,
      msg,
      fields: this.core.redact ? redactFields(combined) : combined,
      err,
    });
  }
}
