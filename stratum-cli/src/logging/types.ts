/**
 * Tipos del sistema de logs de Stratum.
 *
 * Diseño: un `Logger` ligero que produce `LogRecord`s estructurados y los
 * reparte a uno o más `LogSink`. La filosofía del proyecto (implementación
 * propia, cero dependencias pesadas) se respeta: no hay `pino`/`winston`.
 */

/** Niveles ordenados de menor a mayor severidad. `silent` desactiva todo. */
export const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/** Nivel emitible (todo menos `silent`, que solo sirve como umbral). */
export type EmitLevel = Exclude<LogLevel, 'silent'>;

/** Orden numérico para comparar severidades. */
export const LEVEL_ORDER: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  silent: 100,
};

/** Comprueba si `s` es un `LogLevel` válido (útil para parsear flags/env). */
export function isLogLevel(s: string): s is LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(s);
}

/** Error serializado de forma segura para JSON. */
export interface SerializedError {
  name: string;
  message: string;
  stack?: string;
}

/** Registro estructurado de una entrada de log. */
export interface LogRecord {
  /** Marca de tiempo ISO-8601. */
  time: string;
  level: EmitLevel;
  /** Namespace jerárquico, p. ej. `agent.loop` o `provider`. */
  ns: string;
  msg: string;
  /** Campos estructurados arbitrarios (ya redactados). */
  fields?: Record<string, unknown>;
  /** Error asociado, si lo hay. */
  err?: SerializedError;
}

/**
 * Destino de los logs. Cada sink filtra por su propio `level` mínimo.
 * `write` debe ser no bloqueante y no debe lanzar nunca.
 */
export interface LogSink {
  /** Nivel mínimo que este sink acepta. */
  readonly level: LogLevel;
  write(record: LogRecord): void;
  /** Vacía cualquier buffer pendiente (p. ej. la cola de escritura a disco). */
  flush?(): Promise<void>;
  /** Cierra el sink liberando recursos. */
  close?(): Promise<void>;
}
