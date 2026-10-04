import type { TraceRecorder, TraceScope } from './recorder.js';
import { startAuditorServer, type AuditorServer } from './server.js';
import { openInBrowser } from './open-browser.js';

export interface AuditorOpenResult {
  url: string;
  /** El navegador se pudo lanzar; si no, hay que abrir la URL a mano. */
  browser: boolean;
  /** El visor ya estaba levantado: se reutiliza la misma URL. */
  already: boolean;
}

/**
 * La traza de la sesión en curso y su visor (`/auditor`). El servidor se
 * levanta solo cuando se pide y muere con la sesión: la grabación no depende
 * de él.
 */
export class SessionAuditor {
  private server: AuditorServer | null = null;
  private starting: Promise<AuditorServer> | null = null;

  constructor(private readonly recorder: TraceRecorder | null) {}

  /** Scope para `RunOptions.trace`; `undefined` con la traza desactivada. */
  get scope(): TraceScope | undefined {
    return this.recorder?.scope();
  }

  get enabled(): boolean {
    return this.recorder !== null;
  }

  get url(): string | null {
    return this.server?.url ?? null;
  }

  async open(opts?: { browser?: boolean }): Promise<AuditorOpenResult> {
    if (!this.recorder) throw new Error('La traza está desactivada (trace.enabled: false).');
    const already = this.server !== null;
    if (!this.server) {
      // Dos `/auditor` seguidos comparten el mismo arranque.
      this.starting ??= startAuditorServer({
        file: this.recorder.file,
        sessionId: this.recorder.sessionId,
      });
      try {
        this.server = await this.starting;
      } finally {
        this.starting = null;
      }
    }
    const browser = opts?.browser === false ? false : await openInBrowser(this.server.url);
    return { url: this.server.url, browser, already };
  }

  /** Cierra el visor. Devuelve `false` si no estaba levantado. */
  async stop(): Promise<boolean> {
    const server = this.server;
    if (!server) return false;
    this.server = null;
    await server.close();
    return true;
  }

  /** Teardown de la sesión: cierra el visor y vacía la cola de escritura. */
  async dispose(): Promise<void> {
    await this.stop();
    await this.recorder?.flush();
  }
}
