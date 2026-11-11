/**
 * Ciclo de vida del GTFS estático (Cercanías y larga distancia, cada uno con su
 * propio índice y su propio gestor, independientes): descarga el zip de Renfe,
 * reconstruye el índice y lo mantiene al día (una vez al día, de fecha de Madrid). La
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
import { LD_INDEX_FILE, buildLdIndex } from './index-ld-build.js';
import { RenfeIndex } from './queries.js';
import { LdIndex } from './queries-ld.js';
import { madridParts } from './time.js';

export const STATIC_URL = 'https://ssl.renfe.com/ftransit/Fichero_CER_FOMENTO/fomento_transit.zip';
export const LD_STATIC_URL = 'https://ssl.renfe.com/gtransit/Fichero_AV_LD/google_transit.zip';
const DOWNLOAD_TIMEOUT_MS = 120_000;
const USER_AGENT = 'stratum-connector-renfe/1.0';
/** Tras un fallo, no se reintenta hasta pasado este tiempo. */
const RETRY_AFTER_MS = 30 * 60_000;

export const PREPARING_MESSAGE =
  'Estoy preparando los horarios de Renfe por primera vez (tarda alrededor de un minuto). Vuelve a intentarlo en un momento.';
export const PREPARING_LD_MESSAGE =
  'Estoy preparando los horarios de larga distancia de Renfe por primera vez (tarda unos segundos). Vuelve a intentarlo en un momento.';

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

/** Lo que el gestor necesita saber de un índice abierto. */
interface ManagedIndex {
  meta: { builtAt: string };
  close(): void;
}

/**
 * Ciclo de vida común de un índice: arranque, renovación diaria en segundo plano,
 * último índice bueno tras un fallo y reintento a los 30 min. Cada subclase dice
 * qué fichero es, de dónde se descarga y cómo se abre y se construye.
 */
abstract class BaseIndexManager<I extends ManagedIndex> {
  private building: Promise<void> | null = null;
  private lastError: string | null = null;
  private lastFailureAt = 0;
  protected readonly now: () => Date;
  protected readonly log: (msg: string) => void;

  protected abstract readonly indexFile: string;
  protected abstract readonly defaultUrl: string;
  /** Prefijo del zip temporal (dos gestores en el mismo directorio no deben pisarse). */
  protected abstract readonly zipPrefix: string;
  protected abstract readonly preparingMessage: string;
  protected abstract open(path: string): Promise<I | null>;
  /** Construye el índice desde el zip y devuelve la línea de log del resultado. */
  protected abstract build(
    zipPath: string,
    url: string,
    feedDate: string | undefined,
  ): Promise<string>;

  constructor(protected readonly opts: IndexManagerOptions) {
    this.now = opts.now ?? (() => new Date());
    this.log = opts.log ?? ((m) => process.stderr.write(`[renfe] ${m}\n`));
  }

  private get indexPath(): string {
    return join(this.opts.dir, this.indexFile);
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
    const ix = await this.open(this.indexPath);
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
    const zipPath = join(this.opts.dir, `${this.zipPrefix}.${process.pid}.tmp.zip`);
    const url = this.opts.url ?? this.defaultUrl;
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
      this.log(await this.build(zipPath, url, feedDate));
    } finally {
      rmSync(zipPath, { force: true });
    }
  }

  /** Abre el índice, ejecuta `fn` y lo cierra. `ToolUserError` si no hay índice todavía. */
  async withIndex<T>(fn: (ix: I) => Promise<T> | T): Promise<T> {
    const ix = await this.open(this.indexPath);
    if (!ix) {
      if (!this.building && this.lastError) {
        void this.refreshIfStale();
        throw new ToolUserError(
          `No he podido descargar los horarios de Renfe (${this.lastError}). Vuelvo a intentarlo; prueba de nuevo en unos minutos.`,
        );
      }
      void this.refreshIfStale();
      throw new ToolUserError(this.preparingMessage);
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

/** Cercanías y Rodalies (`index.db`). */
export class IndexManager extends BaseIndexManager<RenfeIndex> {
  protected readonly indexFile = INDEX_FILE;
  protected readonly defaultUrl = STATIC_URL;
  protected readonly zipPrefix = 'feed';
  protected readonly preparingMessage = PREPARING_MESSAGE;

  protected open(path: string): Promise<RenfeIndex | null> {
    return RenfeIndex.open(path);
  }

  protected async build(zipPath: string, url: string, feedDate: string | undefined) {
    const r = await buildIndex({
      zipPath,
      dir: this.opts.dir,
      sourceUrl: url,
      feedDate,
      now: this.now,
      warn: this.log,
    });
    return `índice listo: ${r.trips} viajes, ${r.stopTimes} horas de paso, ${r.ms} ms`;
  }
}

/** Larga y media distancia (`index-ld.db`), independiente del de Cercanías. */
export class LdIndexManager extends BaseIndexManager<LdIndex> {
  protected readonly indexFile = LD_INDEX_FILE;
  protected readonly defaultUrl = LD_STATIC_URL;
  protected readonly zipPrefix = 'feed-ld';
  protected readonly preparingMessage = PREPARING_LD_MESSAGE;

  protected open(path: string): Promise<LdIndex | null> {
    return LdIndex.open(path);
  }

  protected async build(zipPath: string, url: string, feedDate: string | undefined) {
    const r = await buildLdIndex({
      zipPath,
      dir: this.opts.dir,
      sourceUrl: url,
      feedDate,
      now: this.now,
    });
    return `índice de larga distancia listo: ${r.trips} viajes, ${r.stopTimes} horas de paso, ${r.ms} ms`;
  }
}
