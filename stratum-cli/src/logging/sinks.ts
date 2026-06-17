/**
 * Sinks del sistema de logs.
 *
 *  - `StderrSink`: salida legible y coloreada a `process.stderr`. Es el camino
 *    principal en `stratum run` y CI. En `chat` se configura con un umbral
 *    alto (warn+) para no entrelazarse con la UI de Ink (dueña de stdout).
 *  - `FileSink`: persistencia en JSON Lines con rotación por tamaño. Sirve para
 *    depuración post-mortem y para empaquetar trazas en un bug report.
 *  - `MemorySink`: captura en memoria para los tests.
 *
 * Invariante transversal: ningún `write` lanza ni bloquea al llamador. Los
 * errores de E/S del `FileSink` se ignoran (un fallo del logging jamás debe
 * romper el flujo principal del agente).
 */

import { appendFile, mkdir, stat, rename } from 'fs/promises';
import { dirname } from 'path';
import { LEVEL_ORDER, type LogLevel, type LogRecord, type LogSink } from './types.js';

// ---------------------------------------------------------------------------
// StderrSink — salida humana coloreada
// ---------------------------------------------------------------------------

type Colorizer = (s: string) => string;

const NO_COLOR: Colorizer = (s) => s;

/** Códigos ANSI mínimos (evitamos depender de chalk aquí para mantener el
 * módulo de logging autónomo y testeable sin TTY). */
function ansi(code: number): Colorizer {
  return (s) => `[${code}m${s}[0m`;
}

const LEVEL_COLOR: Record<string, Colorizer> = {
  trace: ansi(90), // gris
  debug: ansi(36), // cian
  info: ansi(32), // verde
  warn: ansi(33), // amarillo
  error: ansi(31), // rojo
};

const LEVEL_LABEL: Record<string, string> = {
  trace: 'TRACE',
  debug: 'DEBUG',
  info: 'INFO ',
  warn: 'WARN ',
  error: 'ERROR',
};

export interface StderrSinkOptions {
  level?: LogLevel;
  /** Forzar/desactivar color. Por defecto: TTY y sin `NO_COLOR`. */
  color?: boolean;
  /** Stream de salida (inyectable en tests). Por defecto `process.stderr`. */
  stream?: { write(s: string): void; isTTY?: boolean };
}

function formatFields(fields: Record<string, unknown> | undefined): string {
  if (!fields) return '';
  const parts: string[] = [];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    const val =
      typeof v === 'string' ? v : typeof v === 'object' ? JSON.stringify(v) : String(v);
    parts.push(`${k}=${val}`);
  }
  return parts.length > 0 ? ' ' + parts.join(' ') : '';
}

export class StderrSink implements LogSink {
  readonly level: LogLevel;
  private readonly stream: { write(s: string): void; isTTY?: boolean };
  private readonly useColor: boolean;

  constructor(opts: StderrSinkOptions = {}) {
    this.level = opts.level ?? 'info';
    this.stream = opts.stream ?? process.stderr;
    this.useColor =
      opts.color ??
      (Boolean(this.stream.isTTY) && !process.env['NO_COLOR'] && process.env['TERM'] !== 'dumb');
  }

  write(record: LogRecord): void {
    const paint = this.useColor ? (LEVEL_COLOR[record.level] ?? NO_COLOR) : NO_COLOR;
    const time = record.time.slice(11, 23); // HH:MM:SS.mmm
    const label = LEVEL_LABEL[record.level] ?? record.level.toUpperCase();
    const ns = this.useColor ? ansi(90)(record.ns) : record.ns;
    let line = `${time} ${paint(label)} ${ns}: ${record.msg}${formatFields(record.fields)}`;
    if (record.err) {
      line += `\n        ${record.err.name}: ${record.err.message}`;
      if (record.err.stack && (this.level === 'trace' || this.level === 'debug')) {
        line += `\n${record.err.stack}`;
      }
    }
    try {
      this.stream.write(line + '\n');
    } catch {
      /* nunca romper el flujo principal */
    }
  }
}

// ---------------------------------------------------------------------------
// FileSink — JSON Lines con rotación por tamaño
// ---------------------------------------------------------------------------

export interface FileSinkOptions {
  path: string;
  level?: LogLevel;
  /** Tamaño máximo antes de rotar (bytes). Default 5 MB. */
  maxBytes?: number;
  /** Número de ficheros rotados a conservar (`.1` … `.N`). Default 5. */
  maxFiles?: number;
}

export class FileSink implements LogSink {
  readonly level: LogLevel;
  private readonly path: string;
  private readonly maxBytes: number;
  private readonly maxFiles: number;
  private dirEnsured = false;
  /** Cola que serializa escrituras para no entrelazar líneas. */
  private queue: Promise<void> = Promise.resolve();

  constructor(opts: FileSinkOptions) {
    this.path = opts.path;
    this.level = opts.level ?? 'debug';
    this.maxBytes = opts.maxBytes ?? 5 * 1024 * 1024;
    this.maxFiles = opts.maxFiles ?? 5;
  }

  write(record: LogRecord): void {
    const line = JSON.stringify(record) + '\n';
    this.queue = this.queue
      .then(async () => {
        await this.ensureDir();
        await this.rotateIfNeeded();
        await appendFile(this.path, line, 'utf8');
      })
      .catch(() => {
        /* el logging a disco nunca debe romper el flujo principal */
      });
  }

  /** Espera a que se vacíe la cola de escritura (usado al cerrar / en tests). */
  async flush(): Promise<void> {
    await this.queue;
  }

  async close(): Promise<void> {
    await this.flush();
  }

  private async ensureDir(): Promise<void> {
    if (this.dirEnsured) return;
    await mkdir(dirname(this.path), { recursive: true });
    this.dirEnsured = true;
  }

  private async rotateIfNeeded(): Promise<void> {
    let size: number;
    try {
      ({ size } = await stat(this.path));
    } catch {
      return; // aún no existe → nada que rotar
    }
    if (size <= this.maxBytes) return;
    // Desplazar .N-1 → .N, …, base → .1
    for (let i = this.maxFiles - 1; i >= 1; i--) {
      try {
        await rename(`${this.path}.${i}`, `${this.path}.${i + 1}`);
      } catch {
        /* ese índice no existe */
      }
    }
    try {
      await rename(this.path, `${this.path}.1`);
    } catch {
      /* carrera benigna */
    }
  }
}

// ---------------------------------------------------------------------------
// MemorySink — captura en memoria para tests
// ---------------------------------------------------------------------------

export class MemorySink implements LogSink {
  readonly level: LogLevel;
  readonly records: LogRecord[] = [];

  constructor(level: LogLevel = 'trace') {
    this.level = level;
  }

  write(record: LogRecord): void {
    this.records.push(record);
  }

  clear(): void {
    this.records.length = 0;
  }
}

/** Helper compartido: ¿este sink acepta este nivel? */
export function sinkAccepts(sink: LogSink, level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[sink.level];
}
