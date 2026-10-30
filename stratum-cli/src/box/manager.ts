/**
 * M13 — ciclo de vida de la caja: ver, arrancar, parar y borrar
 * (`docs/PRD_STRATUM_DOT.md` §23.3). Lo usan el daemon (`box.*`) y
 * `stratum box`; la sesión del agente nunca, y nunca con una orden suya.
 *
 * - `start` crea la caja si no existe (construyendo antes la imagen de Stratum
 *   si falta) y la recrea si quedó desfasada (otra imagen, otra red): el
 *   volumen de su home se conserva.
 * - `stop` la para; reiniciar el daemon no la toca.
 * - `reset` borra contenedor **y** volumen: todo su trabajo. Quien llama confirma.
 *
 * Un contenedor con el nombre de la caja que no lleve su etiqueta no se toca:
 * no lo creó Stratum.
 */
import { existsSync } from 'fs';
import { mkdir } from 'fs/promises';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { boxHasDesktop, type BoxConfig } from '../config/schema.js';
import {
  BOX_LABEL,
  DEFAULT_BOX_IMAGE,
  boxContainerName,
  boxCreateArgs,
  boxSpecHash,
  boxVolumeName,
  isNoSuchObject,
  parseInspect,
  type BoxSpec,
  type InspectedBox,
  type RuntimeKind,
} from './spec.js';
import {
  defaultRunner,
  detectRuntime,
  type ContainerRuntime,
  type RuntimeDetection,
  type RuntimeRunner,
} from './runtime.js';

export type BoxState = 'unavailable' | 'absent' | 'stopped' | 'running';

export interface BoxStatus {
  name: string;
  state: BoxState;
  runtime: RuntimeKind | null;
  /** Con `unavailable`: por qué. */
  reason?: string;
  image: string;
  network: boolean;
  /** Existe, pero con otra imagen o ajustes: `start` la recrea sin borrar su home. */
  outdated: boolean;
  /** `exec` admite `container:<name>`. */
  enabled: boolean;
  /** Carpeta del anfitrión montada en `/exchange`. */
  exchangeDir: string;
  /** M15 — tiene escritorio virtual (`box.desktop`, `boxHasDesktop`). */
  desktop: boolean;
}

/** M15 — la pantalla de la caja en un momento dado (JPEG en base64). */
export interface BoxScreen {
  mime: 'image/jpeg';
  data: string;
  width: number;
  height: number;
  screenWidth: number;
  screenHeight: number;
  takenAt: number;
}

/** La caja no tiene escritorio, o no está en marcha: no hay pantalla que ver. */
export class BoxScreenUnavailableError extends Error {
  override readonly name = 'BoxScreenUnavailableError';
  constructor(
    message: string,
    readonly reason: 'no-desktop' | 'box-stopped',
  ) {
    super(message);
  }
}

/**
 * Orden fija de la captura para clientes: `<ancho> <alto>` de la pantalla en
 * la primera línea y el JPEG en base64 en la segunda. `$1` es el factor de
 * escala (`100` o `50`), que decide el servidor, nunca un cliente.
 */
export const BOX_SCREEN_CAPTURE =
  'export DISPLAY="${DISPLAY:-:99}"; ' +
  'xdotool getdisplaygeometry || exit 1; ' +
  'import -window root -resize "$1%" -quality 70 jpeg:- | base64 -w0';

/** Peticiones de pantalla dentro de esta ventana comparten la misma captura. */
const SCREEN_REUSE_MS = 400;
const SCREEN_TIMEOUT_MS = 15_000;

/** No hay runtime de contenedores. */
export class BoxUnavailableError extends Error {
  override readonly name = 'BoxUnavailableError';
}

/** El runtime rechazó una orden, o la caja no es de Stratum. */
export class BoxCommandError extends Error {
  override readonly name = 'BoxCommandError';
}

/** Ya hay otra operación de ciclo de vida en curso sobre la caja. */
export class BoxBusyError extends Error {
  override readonly name = 'BoxBusyError';
}

export interface BoxManagerOptions {
  config: BoxConfig;
  /** Por defecto `~/.stratum/companion/exchange`. */
  exchangeDir?: string;
  /** Carpeta con el `Containerfile` de la imagen de Stratum. Por defecto, la del paquete. */
  imageDir?: string | null;
  run?: RuntimeRunner;
  detect?: () => Promise<RuntimeDetection>;
  platform?: NodeJS.Platform;
  /** Líneas de progreso (construcción de la imagen). */
  onProgress?: (line: string) => void;
}

export function defaultExchangeDir(home: string = homedir()): string {
  return join(home, '.stratum', 'companion', 'exchange');
}

/** Fichero que identifica la carpeta de la imagen en el paquete. */
const IMAGE_MARKER = '.stratum-box-image';

/**
 * `box-image/` del paquete. El módulo puede estar en `dist/` (bundle) o en
 * `src/box/` (tsx, tests): se sube hasta dar con la carpeta.
 */
export function bundledBoxImageDir(): string | null {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 4; i++) {
    const candidate = join(dir, 'box-image');
    if (existsSync(join(candidate, IMAGE_MARKER))) return candidate;
    dir = dirname(dir);
  }
  return null;
}

const COMMAND_TIMEOUT_MS = 120_000;
const BUILD_TIMEOUT_MS = 30 * 60_000;
const STOP_GRACE_S = 5;

function clip(text: string): string {
  const t = text.trim();
  return t.length > 600 ? `${t.slice(0, 600)}…` : t;
}

export class BoxManager {
  private readonly run: RuntimeRunner;
  private readonly detect: () => Promise<RuntimeDetection>;
  private readonly exchangeDir: string;
  private busy = false;

  constructor(private readonly opts: BoxManagerOptions) {
    this.run = opts.run ?? defaultRunner;
    this.detect = opts.detect ?? (() => detectRuntime(opts.config.runtime, this.run));
    this.exchangeDir = opts.exchangeDir ?? defaultExchangeDir();
  }

  get name(): string {
    return this.opts.config.name;
  }

  private get image(): string {
    return this.opts.config.image ?? DEFAULT_BOX_IMAGE;
  }

  private spec(runtime: ContainerRuntime): BoxSpec {
    return {
      name: this.name,
      image: this.image,
      network: this.opts.config.network,
      exchangeDir: this.exchangeDir,
      runtime: runtime.kind,
      platform: this.opts.platform ?? process.platform,
    };
  }

  private base(runtime: RuntimeKind | null): Omit<BoxStatus, 'state' | 'outdated'> {
    return {
      name: this.name,
      runtime,
      image: this.image,
      network: this.opts.config.network,
      enabled: this.opts.config.enabled,
      exchangeDir: this.exchangeDir,
      desktop: boxHasDesktop(this.opts.config),
    };
  }

  private screenInFlight: Promise<BoxScreen> | null = null;
  private lastScreen: BoxScreen | null = null;

  /**
   * M15 — la pantalla de la caja, para enseñarla en solo lectura. No es una
   * operación de ciclo de vida (no espera a `exclusive`), y peticiones a la vez
   * o muy seguidas comparten una sola captura. Si el JPEG no cabe en
   * `maxBytes`, se repite a la mitad de tamaño.
   */
  screen(maxBytes: number): Promise<BoxScreen> {
    if (this.lastScreen && Date.now() - this.lastScreen.takenAt < SCREEN_REUSE_MS) {
      return Promise.resolve(this.lastScreen);
    }
    if (!this.screenInFlight) {
      this.screenInFlight = this.captureScreen(maxBytes).finally(() => {
        this.screenInFlight = null;
      });
    }
    return this.screenInFlight;
  }

  private async captureScreen(maxBytes: number): Promise<BoxScreen> {
    if (!boxHasDesktop(this.opts.config)) {
      throw new BoxScreenUnavailableError('The box has no virtual desktop.', 'no-desktop');
    }
    const rt = await this.requireRuntime();
    const found = await this.inspect(rt);
    if (!found?.running) {
      throw new BoxScreenUnavailableError('The box is not running.', 'box-stopped');
    }
    for (const scale of [100, 50] as const) {
      const r = await this.run(
        rt.bin,
        [
          'exec',
          boxContainerName(this.name),
          'sh',
          '-c',
          BOX_SCREEN_CAPTURE,
          'stratum',
          String(scale),
        ],
        { timeoutMs: SCREEN_TIMEOUT_MS },
      );
      if (r.exitCode !== 0) {
        throw new BoxCommandError(
          `Could not capture the box screen: ${clip(r.stderr) || 'no output'}`,
        );
      }
      const [geometry = '', data = ''] = r.stdout.split('\n');
      const m = /^(\d+) (\d+)$/.exec(geometry.trim());
      const b64 = data.trim();
      if (!m || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) {
        throw new BoxCommandError('Unexpected output from the box screen capture.');
      }
      const bytes = Buffer.from(b64, 'base64').length;
      if (bytes > maxBytes && scale === 100) continue;
      if (bytes > maxBytes) throw new BoxCommandError('The box screen capture is too large.');
      const screenWidth = Number(m[1]);
      const screenHeight = Number(m[2]);
      const shot: BoxScreen = {
        mime: 'image/jpeg',
        data: b64,
        width: Math.round((screenWidth * scale) / 100),
        height: Math.round((screenHeight * scale) / 100),
        screenWidth,
        screenHeight,
        takenAt: Date.now(),
      };
      this.lastScreen = shot;
      return shot;
    }
    throw new BoxCommandError('The box screen capture is too large.');
  }

  async status(): Promise<BoxStatus> {
    const detected = await this.detect();
    if (!detected.ok) {
      return { ...this.base(null), state: 'unavailable', reason: detected.reason, outdated: false };
    }
    const rt = detected.runtime;
    try {
      const found = await this.inspect(rt);
      return this.describe(rt, found);
    } catch (err) {
      return {
        ...this.base(rt.kind),
        state: 'unavailable',
        reason: (err as Error).message,
        outdated: false,
      };
    }
  }

  start(): Promise<BoxStatus> {
    return this.exclusive(async () => {
      const rt = await this.requireRuntime();
      let found = await this.inspect(rt);
      if (found && found.spec !== boxSpecHash(this.spec(rt))) {
        // Desfasada: se recrea el contenedor; el volumen (su home) se queda.
        await this.must(rt, ['rm', '-f', boxContainerName(this.name)], 'remove the old box');
        found = null;
      }
      if (!found) await this.create(rt);
      if (!found?.running) {
        await this.must(rt, ['start', boxContainerName(this.name)], 'start the box');
      }
      return this.describe(rt, await this.inspect(rt));
    });
  }

  stop(): Promise<BoxStatus> {
    return this.exclusive(async () => {
      const rt = await this.requireRuntime();
      const found = await this.inspect(rt);
      if (found?.running) {
        await this.must(
          rt,
          ['stop', '-t', String(STOP_GRACE_S), boxContainerName(this.name)],
          'stop the box',
        );
      }
      return this.describe(rt, await this.inspect(rt));
    });
  }

  /** Borra la caja y su volumen. Irreversible: quien llama ya ha confirmado. */
  reset(): Promise<BoxStatus> {
    return this.exclusive(async () => {
      const rt = await this.requireRuntime();
      // `inspect` primero: no se borra un contenedor que no sea de Stratum.
      if (await this.inspect(rt)) {
        await this.must(rt, ['rm', '-f', boxContainerName(this.name)], 'remove the box');
      }
      const vol = await this.run(rt.bin, ['volume', 'rm', '-f', boxVolumeName(this.name)], {
        timeoutMs: COMMAND_TIMEOUT_MS,
      });
      if (vol.exitCode !== 0 && !isNoSuchObject(vol.stderr)) {
        throw new BoxCommandError(`Could not remove the box volume: ${clip(vol.stderr)}`);
      }
      return this.describe(rt, null);
    });
  }

  private async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    if (this.busy) throw new BoxBusyError('Another box operation is in progress.');
    this.busy = true;
    try {
      return await fn();
    } finally {
      this.busy = false;
    }
  }

  private async requireRuntime(): Promise<ContainerRuntime> {
    const detected = await this.detect();
    if (!detected.ok) throw new BoxUnavailableError(detected.reason);
    return detected.runtime;
  }

  private describe(rt: ContainerRuntime, found: InspectedBox | null): BoxStatus {
    if (!found) return { ...this.base(rt.kind), state: 'absent', outdated: false };
    return {
      ...this.base(rt.kind),
      state: found.running ? 'running' : 'stopped',
      outdated: found.spec !== boxSpecHash(this.spec(rt)),
    };
  }

  /** `null` si no existe. Lanza si existe pero no es una caja de Stratum. */
  private async inspect(rt: ContainerRuntime): Promise<InspectedBox | null> {
    const container = boxContainerName(this.name);
    const r = await this.run(rt.bin, ['container', 'inspect', container], {
      timeoutMs: COMMAND_TIMEOUT_MS,
    });
    if (r.exitCode !== 0) {
      if (isNoSuchObject(r.stderr)) return null;
      throw new BoxCommandError(`Could not inspect the box: ${clip(r.stderr) || 'no output'}`);
    }
    let found: InspectedBox;
    try {
      found = parseInspect(r.stdout);
    } catch {
      throw new BoxCommandError(`Unexpected output from "${rt.bin} container inspect".`);
    }
    if (found.label !== this.name) {
      throw new BoxCommandError(
        `A container named "${container}" exists but was not created by Stratum ` +
          `(no ${BOX_LABEL} label). Stratum will not touch it.`,
      );
    }
    return found;
  }

  private async create(rt: ContainerRuntime): Promise<void> {
    await this.ensureImage(rt);
    await mkdir(this.exchangeDir, { recursive: true, mode: 0o700 });
    let args: string[];
    try {
      args = boxCreateArgs(this.spec(rt));
    } catch (err) {
      throw new BoxCommandError((err as Error).message);
    }
    await this.must(rt, args, 'create the box');
  }

  /** La imagen de Stratum se construye en local si falta; una propia la descarga `create`. */
  private async ensureImage(rt: ContainerRuntime): Promise<void> {
    if (this.opts.config.image !== undefined) return;
    const has = await this.run(rt.bin, ['image', 'inspect', this.image], {
      timeoutMs: COMMAND_TIMEOUT_MS,
    });
    if (has.exitCode === 0) return;
    const dir = this.opts.imageDir === undefined ? bundledBoxImageDir() : this.opts.imageDir;
    if (!dir) throw new BoxCommandError('The box image definition is missing from this install.');
    this.opts.onProgress?.(`Building ${this.image} (first start only; this takes a few minutes)…`);
    const built = await this.run(
      rt.bin,
      ['build', '-t', this.image, '-f', join(dir, 'Containerfile'), dir],
      { timeoutMs: BUILD_TIMEOUT_MS, onOutput: this.opts.onProgress },
    );
    if (built.exitCode !== 0) {
      throw new BoxCommandError(`Could not build the box image: ${clip(built.stderr)}`);
    }
  }

  private async must(rt: ContainerRuntime, args: string[], what: string): Promise<void> {
    const r = await this.run(rt.bin, args, { timeoutMs: COMMAND_TIMEOUT_MS });
    if (r.exitCode !== 0) {
      throw new BoxCommandError(`Could not ${what}: ${clip(r.stderr) || 'no output'}`);
    }
  }
}
