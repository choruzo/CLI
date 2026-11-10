import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getLogger } from '../logging/index.js';
import {
  CdpClosedError,
  CdpTimeoutError,
  launchBrowser,
  type CdpConnection,
  type LaunchedBrowser,
  type LaunchOptions,
} from './cdp.js';
import {
  FOCUS_SCRIPT,
  LOCATE_SCRIPT,
  REF_RE,
  SNAPSHOT_SCRIPT,
  invoke,
  parseKeys,
  type KeyChord,
} from './page-scripts.js';
import {
  displayUrl,
  documentStanding,
  inspectUrl,
  subresourceAllowed,
  type DocumentStanding,
  type UrlPolicyContext,
  type UrlVerdict,
} from './policy.js';

/**
 * El navegador de una sesión (encargo del navegador del agente). Uno por
 * sesión, con **una** pestaña, lanzado la primera vez que hace falta y cerrado
 * al desmontar la sesión, tras `idleMinutes` sin uso o al salir el proceso
 * (`cdp.ts` mata el árbol). Perfil efímero en un temporal propio que se borra
 * al cerrar: sin cookies ni sesiones de la persona.
 *
 * La política no vive solo en las tools: el dominio `Fetch` intercepta **toda**
 * petición. Una navegación del documento principal a algo que no es local ni
 * aprobado se falla (un clic, un `location =` o una redirección no saltan la
 * confirmación de `browser_navigate`); lo vetado no se carga nunca; lo privado
 * solo desde un documento local. Descargas denegadas, diálogos descartados,
 * permisos denegados y ventanas emergentes cerradas.
 *
 * Un fallo del navegador es **auxiliar**: las operaciones lanzan
 * `BrowserUnavailableError` o `BrowserActionError` con un texto legible y la
 * sesión sigue. Pasarse del tope de un mensaje, que el proceso salga solo o que
 * no arranque deja el navegador muerto para la sesión (como un LSP caído).
 *
 * Limitación conocida: las conexiones WebSocket no pasan por `Fetch` (CDP no
 * las intercepta) y la política se aplica por nombre de host, no por la IP a la
 * que resuelve (DNS rebinding).
 */

const log = getLogger('browser');

export const BROWSER_LIMITS = {
  /** Caracteres de una instantánea (`browser_snapshot`). */
  snapshotChars: 20_000,
  /** Entradas y bytes del búfer de consola. */
  consoleEntries: 200,
  consoleBytes: 16 * 1024,
  /** Caracteres de una entrada de consola. */
  consoleEntryChars: 1_000,
  /** Caracteres del resultado de `browser_eval`. */
  evalChars: 8 * 1024,
} as const;

const DEFAULT_TIMEOUTS = {
  /** Espera de `load` tras navegar: pasado el plazo se dice, no es un error. */
  loadMs: 20_000,
  /** Plazo de `browser_eval`. */
  evalMs: 10_000,
  /** Lo que se espera tras una acción antes de mirar la página. */
  settleMs: 400,
  /** Si la acción navegó, lo que se espera a que cargue. */
  actionLoadMs: 5_000,
  /** Cierre ordenado del navegador antes de matarlo. */
  closeMs: 3_000,
};

/** Permisos que se deniegan siempre (los que no conozca una versión se ignoran). */
const DENIED_PERMISSIONS = [
  'geolocation',
  'notifications',
  'videoCapture',
  'audioCapture',
  'clipboardReadWrite',
  'clipboardSanitizedWrite',
  'midi',
  'midiSysex',
  'sensors',
  'displayCapture',
  'idleDetection',
  'nfc',
  'windowManagement',
];

/** El navegador no se puede usar en esta sesión (apagado, muerto o no arrancó). */
export class BrowserUnavailableError extends Error {
  override readonly name = 'BrowserUnavailableError';
}

/** La acción no se pudo hacer (ref que ya no existe, URL vetada…); el navegador sigue. */
export class BrowserActionError extends Error {
  override readonly name = 'BrowserActionError';
}

export type BrowserState = 'closed' | 'open' | 'dead';

export interface BrowserStatusInfo {
  state: 'closed' | 'open' | 'unavailable';
  reason?: string;
  url?: string;
  title?: string;
  loading?: boolean;
  canGoBack?: boolean;
  canGoForward?: boolean;
}

export interface PageInfo {
  url: string;
  title: string;
  /** Estado HTTP del documento, si lo hubo (un `file:` no tiene). */
  status?: number;
  /** `load` no llegó en el plazo. */
  timedOut: boolean;
  /** Navegación que el navegador no hizo, y por qué. */
  error?: string;
}

export interface SnapshotResult {
  title: string;
  url: string;
  text: string;
  truncated: boolean;
}

export interface BrowserScreenCapture {
  data: string;
  width: number;
  height: number;
  takenAt: number;
}

export interface BrowserManagerOptions {
  executable: string;
  /** Directorio de la sesión: lo único que se abre con `file:`. */
  cwd: string;
  /** `tools.browser.allowHosts`: cuenta como local. */
  allowHosts?: readonly string[];
  /** Minutos sin uso antes de cerrar el navegador (`tools.browser.idleMinutes`). */
  idleMinutes?: number;
  /** Redacción de secretos de lo que sale (URL, título, consola). */
  redact?: (text: string) => string;
  /** Solo tests: lanzar otra cosa (un navegador falso). */
  launch?: (options: LaunchOptions) => LaunchedBrowser;
  /** Solo tests: argumentos delante de los fijos. */
  argsPrefix?: readonly string[];
  maxMessageBytes?: number;
  commandTimeoutMs?: number;
  timeouts?: Partial<typeof DEFAULT_TIMEOUTS>;
}

interface ConsoleEntry {
  text: string;
  bytes: number;
}

interface Page {
  browser: LaunchedBrowser;
  conn: CdpConnection;
  dir: string;
  sessionId: string;
  targetId: string;
  url: string;
  title: string;
  loading: boolean;
  status?: number;
  /** Quien espera al siguiente `load` (o fin de carga) del documento principal. */
  loadWaiters: Set<() => void>;
  /** Sesiones de los targets hijos (iframes de otro sitio, workers) ya atendidas. */
  children: Map<string, string>;
  /** URL de cada petición en vuelo, para contar las que fallan. */
  requests: Map<string, string>;
  unsubscribe: Array<() => void>;
  /** Se está cerrando a propósito: su desconexión no es una caída. */
  closing: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref?.());
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function rec(v: unknown): Record<string, unknown> {
  return isRecord(v) ? v : {};
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Alto y ancho de un JPEG (marcador SOF). */
export function jpegSize(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = bytes[i + 1]!;
    if (marker >= 0xc0 && marker <= 0xc3) {
      return { height: bytes.readUInt16BE(i + 5), width: bytes.readUInt16BE(i + 7) };
    }
    const length = bytes.readUInt16BE(i + 2);
    i += 2 + length;
  }
  return null;
}

/** Texto de los argumentos de un `console.*`. */
function consoleText(args: unknown): string {
  if (!Array.isArray(args)) return '';
  return args
    .map((a) => {
      const arg = rec(a);
      if (arg.value !== undefined) {
        return typeof arg.value === 'string' ? arg.value : JSON.stringify(arg.value);
      }
      return str(arg.unserializableValue) ?? str(arg.description) ?? str(arg.type) ?? '';
    })
    .join(' ');
}

export class BrowserManager {
  /** Orígenes que la persona confirmó en esta sesión. Solo en memoria. */
  readonly approvedOrigins = new Set<string>();
  private page: Page | null = null;
  private starting: Promise<Page> | null = null;
  private deadReason: string | null = null;
  private disposed = false;
  private idleTimer: NodeJS.Timeout | null = null;
  private busy = 0;
  private consoleEntries: ConsoleEntry[] = [];
  private consoleBytes = 0;
  private consoleDropped = 0;
  private blockedNavigations: string[] = [];
  private standing: DocumentStanding = 'local';
  private readonly timeouts: typeof DEFAULT_TIMEOUTS;
  private readonly redactFn: (text: string) => string;

  constructor(private readonly options: BrowserManagerOptions) {
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...options.timeouts };
    this.redactFn = options.redact ?? ((t) => t);
  }

  get state(): BrowserState {
    if (this.deadReason !== null || this.disposed) return 'dead';
    return this.page ? 'open' : 'closed';
  }

  /** Por qué está muerto, si lo está. */
  get unavailableReason(): string | null {
    return this.disposed ? 'the session is closing' : this.deadReason;
  }

  policyContext(): UrlPolicyContext {
    return {
      cwd: this.options.cwd,
      approvedOrigins: this.approvedOrigins,
      allowHosts: this.options.allowHosts ?? [],
    };
  }

  inspect(url: string): UrlVerdict {
    return inspectUrl(url, this.policyContext());
  }

  /** La persona aprobó navegar a este origen: vale para el resto de la sesión. */
  approveOrigin(origin: string): void {
    this.approvedOrigins.add(origin);
  }

  redact(text: string): string {
    return this.redactFn(text);
  }

  // -------------------------------------------------------------------------
  // Estado (para el protocolo)
  // -------------------------------------------------------------------------

  async status(): Promise<BrowserStatusInfo> {
    if (this.state === 'dead') return { state: 'unavailable', reason: 'failed' };
    const page = this.page;
    if (!page) return { state: 'closed' };
    const info: BrowserStatusInfo = {
      state: 'open',
      url: this.redact(displayUrl(page.url)),
      title: this.redact(clip(page.title, 500)),
      loading: page.loading,
    };
    try {
      const history = await page.conn.send(
        'Page.getNavigationHistory',
        {},
        { sessionId: page.sessionId, timeoutMs: 5000 },
      );
      const index = typeof history.currentIndex === 'number' ? history.currentIndex : 0;
      const entries = Array.isArray(history.entries) ? history.entries.length : 0;
      info.canGoBack = index > 0;
      info.canGoForward = index < entries - 1;
    } catch {
      /* sin historial no se sabe: se omite */
    }
    return info;
  }

  /**
   * La pantalla en JPEG para un cliente (`browser.screen`): otra captura, con
   * orden fija; no es la que ve el agente ni se guarda. `null` si el navegador
   * no está abierto: nunca lo arranca, y mirar no cuenta como uso.
   */
  async screen(maxBytes: number): Promise<BrowserScreenCapture | null> {
    const page = this.page;
    if (!page || this.state !== 'open') return null;
    const attempts: Array<Record<string, unknown>> = [
      { format: 'jpeg', quality: 70 },
      { format: 'jpeg', quality: 45 },
    ];
    try {
      for (let i = 0; i < 3; i++) {
        const params = attempts[i] ??
          // Último intento: a la mitad.
          {
            format: 'jpeg',
            quality: 45,
            clip: { x: 0, y: 0, width: 1280, height: 800, scale: 0.5 },
          };
        const shot = await page.conn.send('Page.captureScreenshot', params, {
          sessionId: page.sessionId,
        });
        const data = str(shot.data) ?? '';
        const bytes = Buffer.from(data, 'base64');
        if (bytes.length > maxBytes) continue;
        const size = jpegSize(bytes);
        if (!size) throw new BrowserActionError('The browser did not return a JPEG.');
        return { data, width: size.width, height: size.height, takenAt: Date.now() };
      }
    } catch (err) {
      throw this.translate(err);
    }
    throw new BrowserActionError('The browser screen does not fit in the size limit.');
  }

  // -------------------------------------------------------------------------
  // Acciones
  // -------------------------------------------------------------------------

  /**
   * Carga `url` en la pestaña. Solo lo local o lo ya aprobado: quien llama ha
   * aprobado antes el origen (o lo pide `browser.navigate` del protocolo, que
   * no aprueba nada).
   */
  async navigate(url: string, signal?: AbortSignal): Promise<PageInfo> {
    const verdict = this.inspect(url);
    if (verdict.class !== 'local' && verdict.class !== 'approved') {
      throw new BrowserActionError(
        verdict.class === 'blocked'
          ? `This URL cannot be opened: ${verdict.reason ?? 'blocked'}.`
          : `Navigation to ${verdict.origin ?? url} needs the user's approval.`,
      );
    }
    return this.withPage(signal, async (page) => {
      this.blockedNavigations = [];
      page.status = undefined;
      const loaded = this.nextLoad(page, this.timeouts.loadMs);
      const result = await page.conn.send(
        'Page.navigate',
        { url: verdict.url!.href },
        { sessionId: page.sessionId, ...(signal ? { signal } : {}) },
      );
      const errorText = str(result.errorText);
      let timedOut = false;
      if (!errorText && str(result.loaderId)) timedOut = !(await loaded.promise);
      loaded.cancel();
      const info = await this.pageInfo(page);
      return { ...info, timedOut, ...(errorText ? { error: errorText } : {}) };
    });
  }

  /** Atrás, adelante o recargar (lo pide una persona desde un cliente). */
  async history(action: 'back' | 'forward' | 'reload', signal?: AbortSignal): Promise<PageInfo> {
    return this.withPage(signal, async (page) => {
      this.blockedNavigations = [];
      if (action === 'reload') {
        await page.conn.send('Page.reload', {}, { sessionId: page.sessionId });
      } else {
        const history = await page.conn.send(
          'Page.getNavigationHistory',
          {},
          { sessionId: page.sessionId },
        );
        const index = typeof history.currentIndex === 'number' ? history.currentIndex : 0;
        const entries = Array.isArray(history.entries) ? history.entries : [];
        const target = rec(entries[action === 'back' ? index - 1 : index + 1]);
        if (typeof target.id !== 'number') {
          throw new BrowserActionError(`There is no page to go ${action} to.`);
        }
        await page.conn.send(
          'Page.navigateToHistoryEntry',
          { entryId: target.id },
          { sessionId: page.sessionId },
        );
      }
      // Una entrada del historial puede salir de la caché sin cargar nada: no
      // se espera un `load` que quizá no llega, solo el que ya empezó.
      const timedOut = !(await this.settle(page, this.timeouts.loadMs));
      return { ...(await this.pageInfo(page)), timedOut };
    });
  }

  async snapshot(signal?: AbortSignal): Promise<SnapshotResult> {
    return this.withPage(signal, (page) => this.takeSnapshot(page, signal));
  }

  async click(ref: string, signal?: AbortSignal): Promise<SnapshotResult> {
    this.checkRef(ref);
    return this.withPage(signal, async (page) => {
      this.blockedNavigations = [];
      const located = rec(await this.evaluateValue(page, invoke(LOCATE_SCRIPT, ref), signal));
      if (located.ok !== true) throw this.staleRef(ref);
      if (located.clicked !== true) {
        const x = Number(located.x);
        const y = Number(located.y);
        for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
          await page.conn.send(
            'Input.dispatchMouseEvent',
            { type, x, y, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: 1 },
            { sessionId: page.sessionId },
          );
        }
      }
      await this.settle(page);
      return this.takeSnapshot(page, signal);
    });
  }

  async type(
    ref: string,
    text: string,
    submit: boolean,
    signal?: AbortSignal,
  ): Promise<SnapshotResult> {
    this.checkRef(ref);
    return this.withPage(signal, async (page) => {
      this.blockedNavigations = [];
      const focused = rec(await this.evaluateValue(page, invoke(FOCUS_SCRIPT, ref), signal));
      if (focused.ok !== true) throw this.staleRef(ref);
      if (focused.editable !== true) {
        throw new BrowserActionError(
          `[${ref}] does not accept text (it is not an enabled text field).`,
        );
      }
      await page.conn.send('Input.insertText', { text }, { sessionId: page.sessionId });
      if (submit) {
        const parsed = parseKeys('Enter');
        if (parsed.ok) await this.pressChord(page, parsed.chords[0]!);
      }
      await this.settle(page);
      return this.takeSnapshot(page, signal);
    });
  }

  async press(keys: string, signal?: AbortSignal): Promise<SnapshotResult> {
    const parsed = parseKeys(keys);
    if (!parsed.ok) throw new BrowserActionError(parsed.error);
    return this.withPage(signal, async (page) => {
      this.blockedNavigations = [];
      for (const chord of parsed.chords) await this.pressChord(page, chord);
      await this.settle(page);
      return this.takeSnapshot(page, signal);
    });
  }

  /** Evalúa una expresión del modelo; el resultado, serializado y acotado. */
  async evaluate(expression: string, signal?: AbortSignal): Promise<string> {
    return this.withPage(signal, async (page) => {
      let result: Record<string, unknown>;
      try {
        result = await page.conn.send(
          'Runtime.evaluate',
          {
            expression,
            returnByValue: true,
            awaitPromise: true,
            userGesture: true,
            timeout: this.timeouts.evalMs,
          },
          {
            sessionId: page.sessionId,
            timeoutMs: this.timeouts.evalMs + 2000,
            ...(signal ? { signal } : {}),
          },
        );
      } catch (err) {
        if (err instanceof CdpTimeoutError) {
          await page.conn
            .send('Runtime.terminateExecution', {}, { sessionId: page.sessionId, timeoutMs: 2000 })
            .catch(() => undefined);
          throw new BrowserActionError(
            `The expression did not finish within ${this.timeouts.evalMs / 1000} s.`,
          );
        }
        throw err;
      }
      const details = rec(result.exceptionDetails);
      if (Object.keys(details).length > 0) {
        const exception = rec(details.exception);
        const text = str(exception.description) ?? str(details.text) ?? 'exception';
        throw new BrowserActionError(`The expression threw: ${clip(this.redact(text), 2000)}`);
      }
      const value = rec(result.result);
      let out: string;
      if (value.type === 'undefined') out = 'undefined';
      else if ('value' in value) {
        out =
          typeof value.value === 'string'
            ? JSON.stringify(value.value)
            : (JSON.stringify(value.value, null, 2) ?? 'undefined');
      } else
        out = str(value.description) ?? str(value.unserializableValue) ?? str(value.type) ?? '';
      out = this.redact(out);
      return out.length > BROWSER_LIMITS.evalChars
        ? `${out.slice(0, BROWSER_LIMITS.evalChars)}\n[result truncated at ${BROWSER_LIMITS.evalChars} characters]`
        : out;
    });
  }

  /** Captura PNG de la pestaña para el agente (`ToolResult.image`). */
  async screenshotPng(signal?: AbortSignal): Promise<string> {
    return this.withPage(signal, async (page) => {
      const shot = await page.conn.send(
        'Page.captureScreenshot',
        { format: 'png' },
        { sessionId: page.sessionId, ...(signal ? { signal } : {}) },
      );
      return str(shot.data) ?? '';
    });
  }

  /** Consola, excepciones y peticiones fallidas desde la última lectura (redactado). */
  takeConsole(): string[] {
    const lines = this.consoleEntries.map((e) => e.text);
    if (this.consoleDropped > 0) {
      lines.unshift(`[${this.consoleDropped} older entries dropped]`);
    }
    this.consoleEntries = [];
    this.consoleBytes = 0;
    this.consoleDropped = 0;
    return lines;
  }

  /** Errores de consola pendientes de leer (sin vaciar el búfer). */
  pendingErrors(): number {
    return this.consoleEntries.filter((e) => /^(error|exception|request failed)/.test(e.text))
      .length;
  }

  /** Navegaciones del documento principal que se bloquearon desde la última acción. */
  takeBlockedNavigations(): string[] {
    const out = this.blockedNavigations;
    this.blockedNavigations = [];
    return out;
  }

  /** Cierra el navegador (inactividad); la sesión puede volver a abrirlo. */
  async close(): Promise<void> {
    await this.closePage('closed');
  }

  /** Cierre de la sesión: el navegador no vuelve. Nunca rechaza. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.clearIdle();
    if (this.starting) await this.starting.catch(() => undefined);
    await this.closePage('session closed');
  }

  // -------------------------------------------------------------------------
  // Internos
  // -------------------------------------------------------------------------

  private checkRef(ref: string): void {
    if (!REF_RE.test(ref)) {
      throw new BrowserActionError(
        `"${ref}" is not an element reference (use one like e12 from browser_snapshot).`,
      );
    }
  }

  private staleRef(ref: string): BrowserActionError {
    return new BrowserActionError(
      `[${ref}] is not on the page any more (or is from an older snapshot). Call browser_snapshot and use a reference from it.`,
    );
  }

  /** Arranca si hace falta y ejecuta `fn` con la pestaña; cuenta como uso. */
  private async withPage<T>(
    signal: AbortSignal | undefined,
    fn: (page: Page) => Promise<T>,
  ): Promise<T> {
    this.busy++;
    this.clearIdle();
    try {
      const page = await this.ensurePage();
      if (signal?.aborted) throw new BrowserActionError('Cancelled.');
      return await fn(page);
    } catch (err) {
      throw this.translate(err);
    } finally {
      this.busy--;
      this.armIdle();
    }
  }

  private translate(err: unknown): Error {
    if (err instanceof BrowserUnavailableError || err instanceof BrowserActionError) return err;
    if (err instanceof CdpClosedError) {
      return new BrowserUnavailableError(
        `The browser is not available in this session: ${this.deadReason ?? err.message}`,
      );
    }
    if (err instanceof Error && err.name === 'AbortError')
      return new BrowserActionError('Cancelled.');
    if (err instanceof CdpTimeoutError)
      return new BrowserActionError(`The browser did not answer: ${err.message}.`);
    return new BrowserActionError(
      `The browser failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private armIdle(): void {
    this.clearIdle();
    if (this.busy > 0 || !this.page || this.disposed) return;
    const minutes = this.options.idleMinutes ?? 15;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.busy > 0) return;
      log.info('browser idle, closing');
      void this.closePage('idle');
    }, minutes * 60_000);
    this.idleTimer.unref?.();
  }

  private async ensurePage(): Promise<Page> {
    if (this.disposed) throw new BrowserUnavailableError('The session is closing.');
    if (this.deadReason !== null) {
      throw new BrowserUnavailableError(
        `The browser is not available in this session: ${this.deadReason}`,
      );
    }
    if (this.page) return this.page;
    if (!this.starting) {
      this.starting = this.start().finally(() => {
        this.starting = null;
      });
    }
    return this.starting;
  }

  private async start(): Promise<Page> {
    const dir = await mkdtemp(join(tmpdir(), 'stratum-browser-'));
    let browser: LaunchedBrowser | undefined;
    try {
      const launch = this.options.launch ?? launchBrowser;
      let page: Page | null = null;
      browser = launch({
        executable: this.options.executable,
        userDataDir: dir,
        ...(this.options.argsPrefix ? { argsPrefix: this.options.argsPrefix } : {}),
        ...(this.options.maxMessageBytes !== undefined
          ? { maxMessageBytes: this.options.maxMessageBytes }
          : {}),
        ...(this.options.commandTimeoutMs !== undefined
          ? { timeoutMs: this.options.commandTimeoutMs }
          : {}),
        onClose: (reason) => {
          if (page) this.onPageLost(page, reason);
        },
      });
      page = await this.setUp(browser, dir);
      if (page.conn.closed !== null) throw new Error(page.conn.closed);
      if (this.disposed) {
        await this.destroy(page);
        throw new BrowserUnavailableError('The session is closing.');
      }
      this.page = page;
      this.standing = 'local';
      log.info('browser started', { pid: browser.pid });
      return page;
    } catch (err) {
      if (err instanceof BrowserUnavailableError) throw err;
      const reason = `it could not start (${err instanceof Error ? err.message : String(err)})`;
      this.deadReason = reason;
      log.warn('browser failed to start', {
        error: this.redact(err instanceof Error ? err.message : String(err)),
        ...(browser?.stderrTail() ? { stderr: this.redact(browser.stderrTail().trim()) } : {}),
      });
      if (browser) await browser.kill();
      await removeDir(dir);
      throw new BrowserUnavailableError(`The browser is not available in this session: ${reason}`);
    }
  }

  /** Dominios, política y la única pestaña. Cualquier fallo aquí aborta el arranque. */
  private async setUp(browser: LaunchedBrowser, dir: string): Promise<Page> {
    const conn = browser.connection;
    const page: Page = {
      browser,
      conn,
      dir,
      sessionId: '',
      targetId: '',
      url: 'about:blank',
      title: '',
      loading: false,
      loadWaiters: new Set(),
      children: new Map(),
      requests: new Map(),
      unsubscribe: [],
      closing: false,
    };
    const on = (
      method: string,
      handler: (p: Record<string, unknown>, s: string | undefined) => void,
    ) => page.unsubscribe.push(conn.on(method, handler));

    // Descargas fuera; permisos denegados (los que esta versión no conozca, ignorados).
    await conn.send('Browser.setDownloadBehavior', { behavior: 'deny' });
    for (const name of DENIED_PERMISSIONS) {
      await conn
        .send('Browser.setPermission', { permission: { name }, setting: 'denied' })
        .catch(() => undefined);
    }

    // Cada target nuevo llega en pausa: la pestaña principal se adopta, una
    // emergente se cierra antes de que cargue nada, y un iframe o un worker
    // solo sigue con la política en su red (si no se puede, se queda en pausa).
    let resolveMain: (sessionId: string, targetId: string) => void = () => undefined;
    const main = new Promise<{ sessionId: string; targetId: string }>((resolve) => {
      resolveMain = (sessionId, targetId) => resolve({ sessionId, targetId });
    });
    on('Target.attachedToTarget', (params) => {
      const sessionId = str(params.sessionId);
      const info = rec(params.targetInfo);
      const targetId = str(info.targetId);
      const type = str(info.type);
      if (!sessionId || !targetId) return;
      if (type === 'page') {
        if (!page.sessionId) {
          page.sessionId = sessionId;
          page.targetId = targetId;
          resolveMain(sessionId, targetId);
        } else if (targetId !== page.targetId) {
          void conn.send('Target.closeTarget', { targetId }).catch(() => undefined);
        }
        return;
      }
      if (page.children.has(targetId) || targetId === page.targetId) {
        void conn.send('Target.detachFromTarget', { sessionId }).catch(() => undefined);
        return;
      }
      page.children.set(targetId, sessionId);
      void (async () => {
        try {
          await conn.send(
            'Fetch.enable',
            { patterns: [{ urlPattern: '*', requestStage: 'Request' }] },
            { sessionId },
          );
        } catch {
          // Sin intercepción no corre: se queda en pausa (falla cerrado).
          return;
        }
        await conn
          .send('Runtime.runIfWaitingForDebugger', {}, { sessionId })
          .catch(() => undefined);
      })();
    });
    on('Target.detachedFromTarget', (params) => {
      const sessionId = str(params.sessionId);
      for (const [target, s] of page.children) if (s === sessionId) page.children.delete(target);
      if (sessionId && sessionId === page.sessionId) this.onPageLost(page, 'the tab was closed');
    });
    on('Target.targetCrashed', (params) => {
      if (str(params.targetId) === page.targetId) this.onPageLost(page, 'the page crashed');
    });

    on('Fetch.requestPaused', (params, sessionId) => this.onRequestPaused(page, params, sessionId));
    on('Page.javascriptDialogOpening', (params, sessionId) => {
      const type = str(params.type) ?? 'alert';
      this.pushConsole(`dialog (${type}) dismissed: ${str(params.message) ?? ''}`);
      // `beforeunload` se acepta: si no, ninguna navegación saldría de la página.
      void conn
        .send(
          'Page.handleJavaScriptDialog',
          { accept: type === 'beforeunload' },
          sessionId ? { sessionId } : {},
        )
        .catch(() => undefined);
    });
    on('Page.frameStartedLoading', (params, sessionId) => {
      if (sessionId === page.sessionId && str(params.frameId) === page.targetId)
        page.loading = true;
    });
    const loadDone = (sessionId: string | undefined, frameId?: string) => {
      if (sessionId !== page.sessionId) return;
      if (frameId !== undefined && frameId !== page.targetId) return;
      page.loading = false;
      for (const waiter of [...page.loadWaiters]) waiter();
    };
    on('Page.loadEventFired', (_params, sessionId) => loadDone(sessionId));
    on('Page.frameStoppedLoading', (params, sessionId) => loadDone(sessionId, str(params.frameId)));
    on('Page.frameNavigated', (params, sessionId) => {
      const frame = rec(params.frame);
      if (sessionId === page.sessionId && !frame.parentId && typeof frame.url === 'string') {
        page.url = frame.url;
        // Lo que vale es el documento que quedó cargado, no la última petición:
        // volver atrás puede restaurarlo de la caché sin pasar por `Fetch`. Un
        // `about:blank` hereda el origen de quien lo abrió: no cambia nada.
        if (frame.url !== 'about:blank') {
          const ctx = this.policyContext();
          this.standing = documentStanding(inspectUrl(frame.url, ctx), ctx.allowHosts);
        }
      }
    });
    on('Runtime.consoleAPICalled', (params) => {
      const type = str(params.type) ?? 'log';
      const level =
        type === 'error' || type === 'assert' ? 'error' : type === 'warning' ? 'warning' : type;
      this.pushConsole(`${level}: ${consoleText(params.args)}`);
    });
    on('Runtime.exceptionThrown', (params) => {
      const details = rec(params.exceptionDetails);
      const exception = rec(details.exception);
      this.pushConsole(
        `exception: ${str(exception.description) ?? str(details.text) ?? 'unknown'}`,
      );
    });
    on('Log.entryAdded', (params) => {
      const entry = rec(params.entry);
      const level = str(entry.level) ?? 'info';
      if (level !== 'error' && level !== 'warning') return;
      this.pushConsole(
        `${level}: ${str(entry.text) ?? ''}${entry.url ? ` (${String(entry.url)})` : ''}`,
      );
    });
    on('Network.requestWillBeSent', (params) => {
      const id = str(params.requestId);
      const url = str(rec(params.request).url);
      if (!id || !url) return;
      if (page.requests.size > 500) page.requests.clear();
      page.requests.set(id, url);
    });
    on('Network.responseReceived', (params, sessionId) => {
      const response = rec(params.response);
      const status = typeof response.status === 'number' ? response.status : undefined;
      if (
        sessionId === page.sessionId &&
        params.type === 'Document' &&
        str(params.frameId) === page.targetId
      ) {
        page.status = status;
      }
      if (status !== undefined && status >= 400) {
        this.pushConsole(`request failed: ${displayUrl(str(response.url) ?? '')} → ${status}`);
      }
    });
    on('Network.loadingFailed', (params) => {
      const id = str(params.requestId) ?? '';
      const url = page.requests.get(id) ?? '';
      page.requests.delete(id);
      if (params.canceled === true) return;
      this.pushConsole(`request failed: ${displayUrl(url)} (${str(params.errorText) ?? 'error'})`);
    });
    on('Network.loadingFinished', (params) => {
      page.requests.delete(str(params.requestId) ?? '');
    });

    await conn.send('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
    });
    // La pestaña de `about:blank` ya existe: el auto-attach la entrega. Si no
    // llegase, se crea una (que llega en pausa por el mismo camino).
    const first = await Promise.race([main, sleep(5000).then(() => null)]);
    let target = first;
    if (!target) {
      await conn.send('Target.createTarget', { url: 'about:blank' });
      target = await Promise.race([main, sleep(5000).then(() => null)]);
      if (!target) throw new Error('the browser did not open a tab');
    }
    const sessionId = target.sessionId;
    const s = { sessionId };
    await conn.send(
      'Fetch.enable',
      { patterns: [{ urlPattern: '*', requestStage: 'Request' }] },
      s,
    );
    await conn.send('Page.enable', {}, s);
    await conn.send('Runtime.enable', {}, s);
    await conn.send('Network.enable', {}, s);
    await conn.send('Log.enable', {}, s).catch(() => undefined);
    // Los iframes de otro sitio y los workers de la pestaña, también en pausa.
    await conn.send(
      'Target.setAutoAttach',
      { autoAttach: true, waitForDebuggerOnStart: true, flatten: true },
      s,
    );
    await conn.send('Runtime.runIfWaitingForDebugger', {}, s).catch(() => undefined);
    return page;
  }

  /** La política en la red. Nunca lanza: lo que no se decide, se falla. */
  private onRequestPaused(
    page: Page,
    params: Record<string, unknown>,
    sessionId: string | undefined,
  ): void {
    const requestId = str(params.requestId);
    if (!requestId || !sessionId) return;
    const url = str(rec(params.request).url) ?? '';
    const ctx = this.policyContext();
    let allow = false;
    try {
      const isMainNavigation =
        sessionId === page.sessionId &&
        params.resourceType === 'Document' &&
        str(params.frameId) === page.targetId;
      if (isMainNavigation) {
        const verdict = inspectUrl(url, ctx);
        if (verdict.class === 'local' || verdict.class === 'approved') {
          allow = true;
          // Solo se endurece aquí: el documento de ahora sigue vivo hasta que
          // el nuevo se cargue (`Page.frameNavigated` fija el definitivo), y uno
          // de internet no gana la red privada por pedir una navegación local.
          if (documentStanding(verdict, ctx.allowHosts) === 'other') this.standing = 'other';
        } else {
          this.blockedNavigations.push(
            verdict.class === 'blocked'
              ? `navigation to ${this.redact(displayUrl(url))} blocked: ${verdict.reason ?? 'not allowed'}`
              : `navigation to ${verdict.origin ?? displayUrl(url)} blocked: call browser_navigate to request it`,
          );
          if (this.blockedNavigations.length > 20) this.blockedNavigations.shift();
        }
      } else {
        allow = subresourceAllowed(url, this.standing, ctx);
        if (!allow) this.pushConsole(`request blocked by Stratum: ${displayUrl(url)}`);
      }
    } catch {
      allow = false;
    }
    const s = { sessionId };
    if (allow) {
      void page.conn.send('Fetch.continueRequest', { requestId }, s).catch(() => undefined);
    } else {
      void page.conn
        .send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }, s)
        .catch(() => undefined);
    }
  }

  private pushConsole(raw: string): void {
    const text = clip(this.redact(raw), BROWSER_LIMITS.consoleEntryChars);
    const bytes = Buffer.byteLength(text, 'utf8');
    this.consoleEntries.push({ text, bytes });
    this.consoleBytes += bytes;
    while (
      this.consoleEntries.length > BROWSER_LIMITS.consoleEntries ||
      (this.consoleBytes > BROWSER_LIMITS.consoleBytes && this.consoleEntries.length > 1)
    ) {
      const dropped = this.consoleEntries.shift()!;
      this.consoleBytes -= dropped.bytes;
      this.consoleDropped++;
    }
  }

  /** Espera al siguiente fin de carga del documento principal, con plazo. */
  private nextLoad(
    page: Page,
    timeoutMs: number,
  ): { promise: Promise<boolean>; cancel: () => void } {
    let done: (ok: boolean) => void = () => undefined;
    const promise = new Promise<boolean>((resolve) => {
      done = resolve;
    });
    const waiter = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref?.();
    const finish = (ok: boolean) => {
      clearTimeout(timer);
      page.loadWaiters.delete(waiter);
      done(ok);
    };
    page.loadWaiters.add(waiter);
    return { promise, cancel: () => finish(false) };
  }

  /** Tras una acción: un instante y, si navegó, a que cargue. `false` si no cargó a tiempo. */
  private async settle(page: Page, loadMs = this.timeouts.actionLoadMs): Promise<boolean> {
    await sleep(this.timeouts.settleMs);
    if (!page.loading) return true;
    const loaded = this.nextLoad(page, loadMs);
    const ok = await loaded.promise;
    loaded.cancel();
    return ok;
  }

  private async pressChord(page: Page, chord: KeyChord): Promise<void> {
    const s = { sessionId: page.sessionId };
    for (const mod of chord.modifiers) {
      await page.conn.send(
        'Input.dispatchKeyEvent',
        { type: 'rawKeyDown', key: mod.key, code: mod.code, windowsVirtualKeyCode: mod.keyCode },
        s,
      );
    }
    const mask = chord.mask;
    const { key } = chord;
    // Con Ctrl/Alt/Meta la tecla no escribe: es un atajo.
    const text = key.text !== undefined && (chord.mask & ~8) === 0 ? key.text : undefined;
    await page.conn.send(
      'Input.dispatchKeyEvent',
      {
        type: text !== undefined ? 'keyDown' : 'rawKeyDown',
        key: key.key,
        code: key.code,
        windowsVirtualKeyCode: key.keyCode,
        modifiers: mask,
        ...(text !== undefined ? { text: chord.mask & 8 ? text.toUpperCase() : text } : {}),
      },
      s,
    );
    await page.conn.send(
      'Input.dispatchKeyEvent',
      {
        type: 'keyUp',
        key: key.key,
        code: key.code,
        windowsVirtualKeyCode: key.keyCode,
        modifiers: mask,
      },
      s,
    );
    for (const mod of [...chord.modifiers].reverse()) {
      await page.conn.send(
        'Input.dispatchKeyEvent',
        {
          type: 'keyUp',
          key: mod.key,
          code: mod.code,
          windowsVirtualKeyCode: mod.keyCode,
          modifiers: 0,
        },
        s,
      );
    }
  }

  private async evaluateValue(
    page: Page,
    expression: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const result = await page.conn.send(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: false },
      { sessionId: page.sessionId, timeoutMs: this.timeouts.evalMs, ...(signal ? { signal } : {}) },
    );
    if (Object.keys(rec(result.exceptionDetails)).length > 0) {
      throw new BrowserActionError('The page did not let Stratum read it.');
    }
    return rec(result.result).value;
  }

  private async takeSnapshot(page: Page, signal?: AbortSignal): Promise<SnapshotResult> {
    const value = rec(
      await this.evaluateValue(page, invoke(SNAPSHOT_SCRIPT, BROWSER_LIMITS.snapshotChars), signal),
    );
    const title = this.redact(clip(str(value.title) ?? '', 300));
    const url = this.redact(displayUrl(str(value.url) ?? page.url));
    page.title = str(value.title) ?? page.title;
    // Redactar antes de recortar: un secreto cortado dejaría de reconocerse.
    let text = this.redact(str(value.text) ?? '');
    let truncated = value.truncated === true;
    if (text.length > BROWSER_LIMITS.snapshotChars) {
      text = text.slice(0, BROWSER_LIMITS.snapshotChars);
      truncated = true;
    }
    return { title, url, text, truncated };
  }

  private async pageInfo(page: Page): Promise<PageInfo> {
    let title = page.title;
    try {
      const value = await this.evaluateValue(page, 'document.title');
      if (typeof value === 'string') title = value;
    } catch {
      /* el título es accesorio */
    }
    page.title = title;
    return {
      url: this.redact(displayUrl(page.url)),
      title: this.redact(clip(title, 300)),
      ...(page.status !== undefined ? { status: page.status } : {}),
      timedOut: false,
    };
  }

  /** El navegador se fue sin que se le pidiera: muerto para la sesión. */
  private onPageLost(page: Page, reason: string): void {
    if (page.closing || this.page !== page) return;
    this.page = null;
    if (this.deadReason === null && !this.disposed) {
      this.deadReason = reason;
      log.warn('browser lost; disabled for this session', {
        reason: this.redact(reason),
        ...(page.browser.stderrTail()
          ? { stderr: this.redact(page.browser.stderrTail().trim()) }
          : {}),
      });
    }
    this.clearIdle();
    void this.destroy(page);
  }

  private async closePage(why: string): Promise<void> {
    const page = this.page;
    if (!page) return;
    this.page = null;
    this.clearIdle();
    log.info('browser closing', { why });
    await this.destroy(page);
  }

  /** Cierre ordenado, y si no basta, el árbol entero. Borra el perfil. Nunca rechaza. */
  private async destroy(page: Page): Promise<void> {
    if (page.closing) return;
    page.closing = true;
    for (const off of page.unsubscribe) off();
    for (const waiter of [...page.loadWaiters]) waiter();
    if (!page.conn.closed) {
      await page.conn.send('Browser.close', {}, { timeoutMs: 2000 }).catch(() => undefined);
    }
    await Promise.race([page.browser.exited, sleep(this.timeouts.closeMs)]);
    // También si ya salió: lo que quede del árbol (renderers, GPU) no sobrevive.
    await page.browser.kill();
    await removeDir(page.dir);
  }
}

/** Borra el perfil efímero; en Windows el proceso puede tardar un poco en soltarlo. */
async function removeDir(dir: string): Promise<void> {
  try {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch (err) {
    log.warn('browser profile not removed', { error: (err as Error).message });
  }
}
