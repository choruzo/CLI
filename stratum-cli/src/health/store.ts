/**
 * M23 — `health.json`, en los datos del `companion`: qué causas de degradación
 * ya se avisaron, para no repetirlas tras reiniciar el daemon. Solo eso: la
 * cuenta de fallos seguidos vive en memoria y se olvida al arrancar.
 *
 * Como `watches.json`: escritura atómica, Zod al leer y `schemaVersion`. Un
 * fichero de un Stratum más nuevo o que no se entiende **no se reescribe**: el
 * monitor sigue con lo avisado en memoria (puede repetir un aviso tras
 * reiniciar, nunca perder el fichero de otro).
 */
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { z } from 'zod';
import { writeFileAtomic } from '../config/writer.js';
import { checkSchemaVersion } from '../config/schema-version.js';
import { getLogger } from '../logging/index.js';
import { HEALTH_LIMITS } from '../protocol/index.js';

const log = getLogger('health');

export const HEALTH_SCHEMA_VERSION = 1;

/** Tope de causas guardadas: hay pocas posibles (una o dos por conector y la caja). */
const MAX_CAUSES = 64;

export function healthFile(companionDir: string): string {
  return join(companionDir, 'health.json');
}

const FileSchema = z
  .object({
    schemaVersion: z.unknown().optional(),
    notified: z
      .array(
        z
          .object({
            cause: z.string().min(1).max(HEALTH_LIMITS.causeChars),
            at: z.number().int(),
          })
          .passthrough(),
      )
      .max(MAX_CAUSES),
  })
  .passthrough();

export class HealthStore {
  private notified = new Map<string, number>();
  private _readOnly = false;

  constructor(private readonly file: string) {}

  get readOnly(): boolean {
    return this._readOnly;
  }

  load(): void {
    this.notified = new Map();
    this._readOnly = false;
    if (!existsSync(this.file)) return;
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.file, 'utf8'));
    } catch (err) {
      // Solo el nombre del error: el mensaje de `JSON.parse` arrastra un trozo del fichero.
      this.block('health.json is not readable; notices are kept in memory only', err);
      return;
    }
    const version = checkSchemaVersion(
      (raw as { schemaVersion?: unknown } | null)?.schemaVersion,
      HEALTH_SCHEMA_VERSION,
    );
    if (!version.ok) {
      this.block(
        version.reason === 'newer'
          ? 'health.json is from a newer Stratum; notices are kept in memory only'
          : 'health.json has an invalid schemaVersion; notices are kept in memory only',
      );
      return;
    }
    const parsed = FileSchema.safeParse(raw);
    if (!parsed.success) {
      this.block('health.json is not valid; notices are kept in memory only');
      return;
    }
    for (const n of parsed.data.notified) this.notified.set(n.cause, n.at);
  }

  has(cause: string): boolean {
    return this.notified.has(cause);
  }

  causes(): string[] {
    return [...this.notified.keys()];
  }

  /** Marca una causa como avisada. Devuelve si cambió algo. */
  add(cause: string, at: number): boolean {
    if (this.notified.has(cause)) return false;
    this.notified.set(cause, at);
    this.persist();
    return true;
  }

  /** Olvida una causa (volvió a ir, o ya no aplica). Devuelve si estaba. */
  remove(cause: string): boolean {
    if (!this.notified.delete(cause)) return false;
    this.persist();
    return true;
  }

  private block(msg: string, err?: unknown): void {
    this._readOnly = true;
    log.warn(msg, { path: this.file, ...(err instanceof Error ? { error: err.name } : {}) });
  }

  private persist(): void {
    if (this._readOnly) return;
    const notified = [...this.notified].slice(-MAX_CAUSES).map(([cause, at]) => ({ cause, at }));
    try {
      writeFileAtomic(
        this.file,
        `${JSON.stringify({ schemaVersion: HEALTH_SCHEMA_VERSION, notified }, null, 2)}\n`,
      );
    } catch (err) {
      // Un fallo al guardar no es un fallo del aviso: como mucho se repetirá tras reiniciar.
      log.warn('health.json could not be written', {
        path: this.file,
        ...(err instanceof Error ? { error: err.name } : {}),
      });
    }
  }
}
