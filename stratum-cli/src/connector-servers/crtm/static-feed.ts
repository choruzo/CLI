/**
 * Ciclo de vida del GTFS de un modo: al arrancar y después una vez al día se
 * consultan los metadatos del item de ArcGIS y **solo se descarga si `modified`
 * cambió** respecto al guardado en el índice. La reconstrucción va en segundo
 * plano (el `initialize` de MCP no puede esperar). Tras un fallo se sigue con el
 * índice anterior y se reintenta a los 30 min. Cada modo tiene su gestor y, si
 * uno falla, los demás siguen. Nunca se desactiva la verificación TLS.
 */
import { createWriteStream, mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { ToolUserError } from '../lib/mcp-stdio.js';
import { dataUrl, feedMode, metaUrl, type ModeId } from './feeds.js';
import { buildModeIndex, indexFile } from './index-build.js';
import { ModeIndex } from './queries.js';

const DOWNLOAD_TIMEOUT_MS = 180_000;
const META_TIMEOUT_MS = 30_000;
const USER_AGENT = 'stratum-connector-crtm/1.0';
/** Cada cuánto se consultan los metadatos. */
export const CHECK_EVERY_MS = 24 * 60 * 60_000;
/** Tras un fallo, no se reintenta hasta pasado este tiempo. */
export const RETRY_AFTER_MS = 30 * 60_000;

/** Directorio de la caché del conector (`…/crtm/`). */
export function crtmCacheDir(): string {
  const root =
    process.env.STRATUM_CONNECTOR_CACHE ?? join(homedir(), '.cache', 'stratum', 'connectors');
  return join(root, 'crtm');
}

export function preparingMessage(mode: ModeId): string {
  return `Estoy preparando los horarios de ${feedMode(mode).label} por primera vez (tarda unos segundos). Vuelve a intentarlo en un momento.`;
}

export interface ModeManagerOptions {
  mode: ModeId;
  dir: string;
  fetch: typeof fetch;
  /** Solo para tests: no descarga nada. */
  offline?: boolean;
  now?: () => Date;
  log?: (msg: string) => void;
}

export class ModeManager {
  private building: Promise<void> | null = null;
  private lastError: string | null = null;
  private lastFailureAt = 0;
  private lastCheckAt = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => Date;
  private readonly log: (msg: string) => void;

  constructor(private readonly opts: ModeManagerOptions) {
    this.now = opts.now ?? (() => new Date());
    this.log = opts.log ?? ((m) => process.stderr.write(`[crtm] ${m}\n`));
  }

  get mode(): ModeId {
    return this.opts.mode;
  }

  private get indexPath(): string {
    return join(this.opts.dir, indexFile(this.opts.mode));
  }

  /** Al arrancar: comprueba y, si hace falta, reconstruye en segundo plano; y vuelve a comprobar cada día. */
  start(): void {
    void this.check();
    if (this.opts.offline) return;
    this.timer = setInterval(() => void this.check(), CHECK_EVERY_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Espera a la comprobación o reconstrucción en curso (para tests). */
  async idle(): Promise<void> {
    await this.building;
  }

  /**
   * Comprueba los metadatos y reconstruye si `modified` cambió (una sola a la
   * vez). Nunca lanza: guarda el error y sigue con el índice anterior.
   */
  check(): Promise<void> {
    if (this.opts.offline) return Promise.resolve();
    if (this.building) return this.building;
    this.building = this.doCheck()
      .then(() => {
        this.lastError = null;
        this.lastFailureAt = 0;
      })
      .catch((err: unknown) => {
        this.lastError = err instanceof Error ? err.message : String(err);
        this.lastFailureAt = this.now().getTime();
        this.log(`${this.opts.mode}: no pude actualizar los horarios: ${this.lastError}`);
      })
      .finally(() => {
        this.lastCheckAt = this.now().getTime();
        this.building = null;
      });
    return this.building;
  }

  /** Lanza una comprobación si toca (cada día, o a los 30 min de un fallo). */
  private maybeCheck(hasIndex: boolean): void {
    if (this.opts.offline || this.building) return;
    const t = this.now().getTime();
    if (this.lastFailureAt > 0) {
      if (t - this.lastFailureAt >= RETRY_AFTER_MS) void this.check();
      return;
    }
    if (!hasIndex || t - this.lastCheckAt >= CHECK_EVERY_MS) void this.check();
  }

  private async doCheck(): Promise<void> {
    const mode = feedMode(this.opts.mode);
    const existing = await ModeIndex.open(this.indexPath);
    const stored = existing?.meta.feedModified ?? null;
    existing?.close();

    const modified = await this.fetchModified(metaUrl(mode));
    if (stored !== null && stored === modified) return;

    mkdirSync(this.opts.dir, { recursive: true });
    const zipPath = join(this.opts.dir, `feed-${this.opts.mode}.${process.pid}.tmp.zip`);
    const url = dataUrl(mode);
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
      const r = await buildModeIndex({
        mode: this.opts.mode,
        zipPath,
        dir: this.opts.dir,
        feedModified: modified,
        now: this.now,
        warn: this.log,
      });
      this.log(
        `${this.opts.mode}: índice listo: ${r.stations} estaciones, ${r.trips} viajes, ${r.patterns} patrones, ${r.ms} ms`,
      );
    } finally {
      rmSync(zipPath, { force: true });
    }
  }

  /** `modified` (ms epoch) del item de ArcGIS, como texto. */
  private async fetchModified(url: string): Promise<string> {
    const res = await this.opts.fetch(url, {
      signal: AbortSignal.timeout(META_TIMEOUT_MS),
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} al consultar ${url}`);
    const json = (await res.json()) as { modified?: unknown };
    if (typeof json.modified !== 'number' || !Number.isFinite(json.modified)) {
      throw new Error('los metadatos del CRTM no traen la fecha de modificación');
    }
    return String(json.modified);
  }

  /**
   * Abre el índice del modo, o `null` si todavía no hay (en construcción o
   * fallida): quien llama decide qué decir. Quien lo abre lo cierra.
   */
  async open(): Promise<ModeIndex | null> {
    const ix = await ModeIndex.open(this.indexPath);
    this.maybeCheck(ix !== null);
    return ix;
  }

  /** Por qué no hay índice (para el mensaje al agente). */
  unavailableMessage(): string {
    if (!this.building && this.lastError) {
      return `No he podido descargar los horarios de ${feedMode(this.opts.mode).label} (${this.lastError}). Vuelvo a intentarlo; prueba de nuevo en unos minutos.`;
    }
    return preparingMessage(this.opts.mode);
  }

  /** Abre el índice o lanza `ToolUserError` con el motivo. */
  async withIndex<T>(fn: (ix: ModeIndex) => Promise<T> | T): Promise<T> {
    const ix = await this.open();
    if (!ix) throw new ToolUserError(this.unavailableMessage());
    try {
      return await fn(ix);
    } finally {
      ix.close();
    }
  }
}
