/**
 * Ciclo de vida del GTFS estático: descarga el zip de Renfe, reconstruye el
 * índice y lo mantiene al día (una vez al día, de fecha de Madrid). La
 * reconstrucción va en segundo plano: el `initialize` de MCP no puede esperar
 * (el cliente da 20 s para arrancar). Nunca se desactiva la verificación TLS: si
 * la descarga falla se sigue con el último índice bueno y las salidas dicen la
 * fecha de sus datos.
 */
import { createWriteStream } from 'node:fs';
import { mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { ToolUserError } from '../lib/mcp-stdio.js';
import { INDEX_FILE, buildIndex } from './index-build.js';
import { RenfeIndex } from './queries.js';
import { madridParts } from './time.js';

export const STATIC_URL = 'https://ssl.renfe.com/ftransit/Fichero_CER_FOMENTO/fomento_transit.zip';
const DOWNLOAD_TIMEOUT_MS = 120_000;
const USER_AGENT = 'stratum-connector-renfe/1.0';
/** Tras un fallo, no se reintenta hasta pasado este tiempo. */
const RETRY_AFTER_MS = 30 * 60_000;

export const PREPARING_MESSAGE =
  'Estoy preparando los horarios de Renfe por primera vez (tarda alrededor de un minuto). Vuelve a intentarlo en un momento.';

/** Directorio de la caché del conector (`…/renfe/`). */
export function renfeCacheDir(): string {
  const root =
    process.env.STRATUM_CONNECTOR_CACHE ?? join(homedir(), '.cache', 'stratum', 'connectors');
  return join(root, 'renfe');
}

export interface IndexManagerOptions {
  dir: string;
  fetch: typeof fetch;
  /** Solo para tests: no descarga nada. */
  offline?: boolean;
  url?: string;
  now?: () => Date;
  log?: (msg: string) => void;
}

export class IndexManager {
  private building: Promise<void> | null = null;
  private lastError: string | null = null;
  private lastFailureAt = 0;
  private readonly now: () => Date;
  private readonly log: (msg: string) => void;

  constructor(private readonly opts: IndexManagerOptions) {
    this.now = opts.now ?? (() => new Date());
    this.log = opts.log ?? ((m) => process.stderr.write(`[renfe] ${m}\n`));
  }

  private get indexPath(): string {
    return join(this.opts.dir, INDEX_FILE);
  }

  /** Al arrancar: si no hay índice o no es de hoy, reconstruye en segundo plano. */
  start(): void {
    void this.refreshIfStale(true);
  }

  private async refreshIfStale(force = false): Promise<void> {
    if (this.opts.offline || this.building) return;
    if (
      !force &&
      this.now().getTime() - this.lastFailureAt < RETRY_AFTER_MS &&
      this.lastFailureAt > 0
    ) {
      return;
    }
    const ix = await RenfeIndex.open(this.indexPath);
    const today = madridParts(this.now()).ymd;
    const builtDay = ix?.meta.builtAt ? madridParts(new Date(ix.meta.builtAt)).ymd : null;
    ix?.close();
    if (builtDay === today) return;
    void this.rebuild();
  }

  /** Reconstruye el índice (una sola a la vez). Nunca lanza: guarda el error. */
  rebuild(): Promise<void> {
    if (this.building) return this.building;
    this.building = this.doRebuild()
      .then(() => {
        this.lastError = null;
        this.lastFailureAt = 0;
      })
      .catch((err: unknown) => {
        this.lastError = err instanceof Error ? err.message : String(err);
        this.lastFailureAt = this.now().getTime();
        this.log(`no pude actualizar los horarios: ${this.lastError}`);
      })
      .finally(() => {
        this.building = null;
      });
    return this.building;
  }

  private async doRebuild(): Promise<void> {
    mkdirSync(this.opts.dir, { recursive: true });
    const zipPath = join(this.opts.dir, `feed.${process.pid}.tmp.zip`);
    const url = this.opts.url ?? STATIC_URL;
    try {
      const res = await this.opts.fetch(url, {
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
        headers: { 'User-Agent': USER_AGENT },
      });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} al descargar ${url}`);
      await pipeline(
        Readable.fromWeb(res.body as unknown as WebReadableStream<Uint8Array>),
        createWriteStream(zipPath),
      );
      const lm = res.headers.get('last-modified');
      const lmDate = lm ? new Date(lm) : null;
      const feedDate =
        lmDate && !Number.isNaN(lmDate.getTime()) ? madridParts(lmDate).ymd : undefined;
      const r = await buildIndex({
        zipPath,
        dir: this.opts.dir,
        sourceUrl: url,
        feedDate,
        now: this.now,
        warn: this.log,
      });
      this.log(`índice listo: ${r.trips} viajes, ${r.stopTimes} horas de paso, ${r.ms} ms`);
    } finally {
      rmSync(zipPath, { force: true });
    }
  }

  /** Abre el índice, ejecuta `fn` y lo cierra. `ToolUserError` si no hay índice todavía. */
  async withIndex<T>(fn: (ix: RenfeIndex) => Promise<T> | T): Promise<T> {
    const ix = await RenfeIndex.open(this.indexPath);
    if (!ix) {
      if (!this.building && this.lastError) {
        void this.refreshIfStale();
        throw new ToolUserError(
          `No he podido descargar los horarios de Renfe (${this.lastError}). Vuelvo a intentarlo; prueba de nuevo en unos minutos.`,
        );
      }
      void this.refreshIfStale();
      throw new ToolUserError(PREPARING_MESSAGE);
    }
    try {
      // Un índice de otro día se renueva en segundo plano; mientras, se usa el viejo.
      if (
        !this.building &&
        madridParts(new Date(ix.meta.builtAt)).ymd !== madridParts(this.now()).ymd
      ) {
        void this.refreshIfStale();
      }
      return await fn(ix);
    } finally {
      ix.close();
    }
  }
}
