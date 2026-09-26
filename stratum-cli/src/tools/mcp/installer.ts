/**
 * Carpeta gestionada de MCP servers (§12.8, opción 2).
 *
 * En lugar de lanzar cada server con `npx -y <pkg>` —que revalida el paquete
 * contra el registro npm en CADA arranque y añade latencia— Stratum instala el
 * paquete una sola vez en `~/.stratum/mcp/<server>/` y resuelve su binario para
 * lanzarlo con `node` directamente. Arranques posteriores son instantáneos y no
 * tocan la red.
 *
 * El patrón replica el del modelo ONNX de la capa de memoria (§12.10), que ya
 * cachea en `~/.stratum/models/`.
 *
 * Instalación transaccional:
 * - `npm install` corre en una carpeta de *staging* propia del proceso
 *   (`.staging-<server>-<pid>-<rand>`) que solo se renombra a `<server>/` cuando
 *   npm terminó y su entry existe. Un `npm install` cortado a mitad ya no deja
 *   una carpeta que parece instalada y falla en cada arranque.
 * - Solo cuenta como instalado lo que tiene **marcador** (`.stratum-install.json`)
 *   con el mismo `package` que la config: cambiar la versión reinstala.
 * - Dos procesos que instalan a la vez no comparten carpeta; gana el primer
 *   rename y el otro descarta la suya. En un mismo proceso, las instalaciones
 *   del mismo server se unen en una sola promesa.
 * - `npm` tiene timeout, y un fallo de auto-instalación no se reintenta durante
 *   `FAILURE_BACKOFF_MS`: la reconexión con backoff del manager no puede
 *   convertirse en un bucle de `npm install`.
 * - Una instalación anterior al marcador (*legacy*) se reinstala; si no se puede
 *   (sin red, `autoInstall: false`), se sigue usando con un aviso.
 */

import { execa } from 'execa';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'fs';
import { join, isAbsolute, relative, resolve, sep } from 'path';
import { randomBytes } from 'crypto';
import { z } from 'zod';
import { expandHome } from '../../config/paths.js';
import { writeFileAtomic } from '../../config/writer.js';
import { renameWithRetry } from '../fs/file-io.js';
import { sanitizeSegment } from './bridge.js';
import type { McpServer } from '../../config/schema.js';

/** Opciones de runtime que el manager pasa a cada cliente. */
export interface McpRuntimeOptions {
  installDir: string; // ya expandido a ruta absoluta
  autoInstall: boolean;
}

/** Comando ejecutable resuelto para `StdioClientTransport`. */
export interface ResolvedCommand {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface InstallOptions {
  /** Tope de `npm install`. Default `NPM_TIMEOUT_MS`. */
  timeoutMs?: number;
  signal?: AbortSignal;
  /**
   * Reemplazar aunque ya haya una instalación completa del mismo `package`
   * (`stratum mcp install --force`). Sin él, si otro proceso terminó antes la
   * misma instalación, se conserva la suya.
   */
  force?: boolean;
  /** Sustituto de `npm install` (tests). Recibe la carpeta de staging. */
  runNpm?: (spec: string, prefix: string) => Promise<void>;
}

export const MARKER_FILE = '.stratum-install.json';
export const NPM_TIMEOUT_MS = 5 * 60_000;
/** Tras un fallo de auto-instalación, no se relanza npm durante este tiempo. */
export const FAILURE_BACKOFF_MS = 60_000;
/** Restos de staging/papelera más viejos que esto son de un proceso que murió. */
const STALE_LEFTOVER_MS = 60 * 60_000;

const MarkerSchema = z.object({
  schemaVersion: z.literal(1),
  server: z.string(),
  package: z.string(),
  /** Entry relativo a la carpeta del server (portable si se mueve `installDir`). */
  entry: z.string(),
  installedAt: z.string(),
});
type InstallMarker = z.infer<typeof MarkerSchema>;

/** Resuelve la carpeta gestionada a ruta absoluta y la crea si no existe. */
export function ensureInstallDir(installDir: string): string {
  const abs = expandHome(installDir);
  mkdirSync(abs, { recursive: true });
  return abs;
}

/** Directorio aislado de un server concreto dentro de la carpeta gestionada. */
export function serverInstallPath(installDir: string, serverName: string): string {
  return join(expandHome(installDir), sanitizeSegment(serverName));
}

/**
 * Deriva el nombre del paquete (sin versión) a partir de un spec npm.
 * `@scope/name@1.2.3` → `@scope/name`; `name@1.2.3` → `name`; `name` → `name`.
 */
export function packageNameFromSpec(spec: string): string {
  if (spec.startsWith('@')) {
    // @scope/name[@version]: el primer '@' es del scope, buscar el segundo
    const at = spec.indexOf('@', 1);
    return at === -1 ? spec : spec.slice(0, at);
  }
  const at = spec.indexOf('@');
  return at === -1 ? spec : spec.slice(0, at);
}

function readMarker(dir: string): InstallMarker | null {
  try {
    const parsed = MarkerSchema.safeParse(
      JSON.parse(readFileSync(join(dir, MARKER_FILE), 'utf-8')),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Entry del marcador como ruta absoluta, o `null` si no existe o se sale de la
 * carpeta del server (un marcador manipulado no elige qué ejecuta `node`).
 */
function markerEntry(dir: string, marker: InstallMarker): string | null {
  const abs = resolve(dir, marker.entry);
  const rel = relative(dir, abs);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null;
  return existsSync(abs) ? abs : null;
}

export type InstallState =
  /** Marcador válido, mismo `package`, entry presente. */
  | { kind: 'installed'; entry: string }
  | { kind: 'missing' }
  /** Instalado, pero con otro `package` (cambió la versión en la config). */
  | { kind: 'outdated'; installed: string }
  /** La carpeta la instaló otro server cuyo nombre se sanitiza igual. */
  | { kind: 'collision'; owner: string }
  /** Anterior al marcador: el paquete está, pero nada garantiza que esté completo. */
  | { kind: 'legacy'; entry: string | null }
  /** Marcador ilegible, o su entry ya no existe. */
  | { kind: 'broken' };

export function installState(serverCfg: McpServer, installDir: string): InstallState {
  if (!serverCfg.package) return { kind: 'missing' };
  const dir = serverInstallPath(installDir, serverCfg.name);
  if (!existsSync(dir)) return { kind: 'missing' };

  if (existsSync(join(dir, MARKER_FILE))) {
    const marker = readMarker(dir);
    if (!marker) return { kind: 'broken' };
    if (marker.server !== serverCfg.name) return { kind: 'collision', owner: marker.server };
    if (marker.package !== serverCfg.package) {
      return { kind: 'outdated', installed: marker.package };
    }
    const entry = markerEntry(dir, marker);
    return entry ? { kind: 'installed', entry } : { kind: 'broken' };
  }

  const pkgJson = join(dir, 'node_modules', packageNameFromSpec(serverCfg.package), 'package.json');
  if (!existsSync(pkgJson)) return { kind: 'missing' };
  let entry: string | null;
  try {
    entry = resolveBinEntry(serverCfg.package, dir);
  } catch {
    entry = null;
  }
  return { kind: 'legacy', entry };
}

/** ¿Está el paquete del server instalado, completo y en la versión de la config? */
export function isServerInstalled(serverCfg: McpServer, installDir: string): boolean {
  return installState(serverCfg, installDir).kind === 'installed';
}

/**
 * Entry-point ejecutable de un paquete instalado bajo `root`, leyendo `bin` (o
 * `main`) de su package.json. Lanza con un mensaje legible si no se encuentra.
 */
function resolveBinEntry(spec: string, root: string): string {
  const pkgName = packageNameFromSpec(spec);
  const pkgDir = join(root, 'node_modules', pkgName);
  const pkgJsonPath = join(pkgDir, 'package.json');
  let pkg: { bin?: string | Record<string, string>; main?: string };
  try {
    pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as typeof pkg;
  } catch (err) {
    throw new Error(
      `No se pudo leer el package.json de '${pkgName}' (${pkgJsonPath}): ${(err as Error).message}`,
    );
  }

  let binRel: string | undefined;
  if (typeof pkg.bin === 'string') {
    binRel = pkg.bin;
  } else if (pkg.bin && typeof pkg.bin === 'object') {
    // Preferir el bin que coincide con el nombre del paquete; si no, el primero.
    const short = pkgName.includes('/') ? pkgName.split('/')[1]! : pkgName;
    binRel = pkg.bin[short] ?? pkg.bin[pkgName] ?? Object.values(pkg.bin)[0];
  }
  binRel = binRel ?? pkg.main;
  if (!binRel) {
    throw new Error(`El paquete '${pkgName}' no declara 'bin' ni 'main'.`);
  }
  const entry = isAbsolute(binRel) ? binRel : join(pkgDir, binRel);
  if (!existsSync(entry)) {
    throw new Error(`El entry '${binRel}' de '${pkgName}' no existe (${entry}).`);
  }
  return entry;
}

/**
 * Borra restos de instalaciones de procesos que murieron: carpetas de staging
 * y papeleras de más de una hora. Best-effort: en Windows una papelera con
 * ficheros aún abiertos no se puede borrar y se reintenta la próxima vez.
 */
function sweepLeftovers(root: string): void {
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return;
  }
  const now = Date.now();
  for (const name of names) {
    if (!name.startsWith('.staging-') && !name.startsWith('.trash-')) continue;
    const p = join(root, name);
    try {
      if (now - statSync(p).mtimeMs < STALE_LEFTOVER_MS) continue;
      rmSync(p, { recursive: true, force: true });
    } catch {
      /* se reintenta en la próxima instalación */
    }
  }
}

/** Instalaciones en curso en este proceso, por carpeta destino. */
const inflight = new Map<string, Promise<void>>();

/**
 * Instala el paquete del server en su carpeta gestionada. Transaccional: o
 * queda la instalación anterior, o la nueva completa con su marcador. Dos
 * llamadas concurrentes del mismo proceso comparten la misma instalación.
 */
export function installServer(
  serverCfg: McpServer,
  installDir: string,
  onLog?: (line: string) => void,
  opts: InstallOptions = {},
): Promise<void> {
  if (!serverCfg.package) {
    return Promise.reject(new Error(`MCP server '${serverCfg.name}' no tiene campo 'package'.`));
  }
  const dir = serverInstallPath(installDir, serverCfg.name);
  const pending = inflight.get(dir);
  if (pending) return pending;
  const run = doInstall(serverCfg, serverCfg.package, installDir, onLog, opts).finally(() =>
    inflight.delete(dir),
  );
  inflight.set(dir, run);
  return run;
}

async function doInstall(
  serverCfg: McpServer,
  spec: string,
  installDir: string,
  onLog: ((line: string) => void) | undefined,
  opts: InstallOptions,
): Promise<void> {
  const root = ensureInstallDir(installDir);
  sweepLeftovers(root);
  const dir = serverInstallPath(installDir, serverCfg.name);
  const segment = sanitizeSegment(serverCfg.name);
  const staging = join(
    root,
    `.staging-${segment}-${process.pid}-${randomBytes(4).toString('hex')}`,
  );
  const timeoutMs = opts.timeoutMs ?? NPM_TIMEOUT_MS;

  try {
    mkdirSync(staging, { recursive: true });
    // package.json mínimo para aislar la instalación (npm no escala al padre).
    writeFileAtomic(
      join(staging, 'package.json'),
      JSON.stringify({ name: `stratum-mcp-${segment}`, private: true }, null, 2),
    );

    onLog?.(`Instalando '${spec}' en ${dir} ...`);
    try {
      if (opts.runNpm) {
        await opts.runNpm(spec, staging);
      } else {
        await execa(
          'npm',
          ['install', spec, '--prefix', staging, '--no-audit', '--no-fund', '--loglevel=error'],
          {
            cwd: staging,
            timeout: timeoutMs,
            cancelSignal: opts.signal,
            forceKillAfterDelay: 2000,
          },
        );
      }
    } catch (err) {
      const e = err as { timedOut?: boolean; isCanceled?: boolean; shortMessage?: string };
      if (e.timedOut) {
        throw new Error(
          `npm install de '${spec}' superó ${Math.round(timeoutMs / 1000)} s y se abortó.`,
        );
      }
      if (e.isCanceled) throw new Error(`Instalación de '${spec}' cancelada.`);
      throw new Error(`npm install de '${spec}' falló: ${e.shortMessage ?? String(err)}`);
    }

    const entry = resolveBinEntry(spec, staging);
    const marker: InstallMarker = {
      schemaVersion: 1,
      server: serverCfg.name,
      package: spec,
      entry: relative(staging, entry).split(sep).join('/'),
      installedAt: new Date().toISOString(),
    };
    // El marcador va lo último: sin él, la carpeta nunca cuenta como instalada.
    writeFileAtomic(join(staging, MARKER_FILE), JSON.stringify(marker, null, 2));

    if (promote(staging, dir, serverCfg, root, opts.force === true)) {
      onLog?.(`Server '${serverCfg.name}' instalado.`);
    } else {
      onLog?.(`Server '${serverCfg.name}' ya lo instaló otro proceso; se usa esa instalación.`);
    }
  } finally {
    // Tras promover, `staging` ya no existe; si algo falló o se descartó, se borra aquí.
    rmSync(staging, { recursive: true, force: true });
  }
}

/**
 * Sustituye `dir` por `staging`. Devuelve `false` si se descartó `staging`
 * porque otro proceso terminó antes la misma instalación. Si `dir` no se puede
 * apartar (Windows con el server en ejecución), la instalación anterior queda
 * intacta y se lanza.
 */
function promote(
  staging: string,
  dir: string,
  serverCfg: McpServer,
  root: string,
  force: boolean,
): boolean {
  if (!existsSync(dir)) {
    try {
      renameWithRetry(staging, dir);
      return true;
    } catch (err) {
      // Otro proceso promovió entre medias: vale si es la misma instalación.
      if (installState(serverCfg, root).kind === 'installed') return false;
      throw err;
    }
  }
  if (!force && installState(serverCfg, root).kind === 'installed') return false;

  const trash = join(
    root,
    `.trash-${sanitizeSegment(serverCfg.name)}-${process.pid}-${randomBytes(4).toString('hex')}`,
  );
  try {
    renameWithRetry(dir, trash);
  } catch (err) {
    throw new Error(
      `No se pudo reemplazar la instalación de '${serverCfg.name}' en ${dir}: ` +
        `${(err as Error).message}. ¿Está el server en uso por otra sesión de Stratum? ` +
        'Ciérrala y repite la instalación.',
    );
  }
  try {
    renameWithRetry(staging, dir);
  } catch (err) {
    // Devolver la instalación anterior a su sitio antes de fallar.
    try {
      renameWithRetry(trash, dir);
    } catch {
      /* queda en la papelera; sin carpeta, el siguiente arranque reinstala */
    }
    throw err;
  }
  rmSync(trash, { recursive: true, force: true, maxRetries: 3 });
  return true;
}

/** Último fallo de auto-instalación por carpeta: evita relanzar npm en cada reconexión. */
const recentFailures = new Map<string, { spec: string; at: number; message: string }>();

/** Solo para tests. */
export function resetInstallerStateForTests(): void {
  recentFailures.clear();
  inflight.clear();
}

function describeState(state: InstallState, spec: string): string {
  switch (state.kind) {
    case 'outdated':
      return `instalado '${state.installed}', la config pide '${spec}'`;
    case 'legacy':
      return 'instalación anterior sin marcador de instalación completa';
    case 'broken':
      return 'instalación incompleta o dañada';
    default:
      return 'no está instalado';
  }
}

/**
 * Resuelve el comando ejecutable de un server.
 *
 * - Sin `package`: devuelve `command`/`args`/`env` tal cual.
 * - Con `package`: garantiza la instalación (auto-install si procede) y
 *   devuelve `node <entry> [args...]`, evitando `npx` por completo.
 */
export async function resolveServerCommand(
  serverCfg: McpServer,
  options: McpRuntimeOptions,
  onLog?: (line: string) => void,
  installOpts: InstallOptions = {},
): Promise<ResolvedCommand> {
  if (!serverCfg.package) {
    // El schema garantiza que command está definido cuando package está ausente.
    return { command: serverCfg.command!, args: serverCfg.args, env: serverCfg.env };
  }

  ensureInstallDir(options.installDir);
  const launch = (entry: string): ResolvedCommand => ({
    command: 'node',
    args: [entry, ...serverCfg.args],
    env: serverCfg.env,
  });

  const state = installState(serverCfg, options.installDir);
  if (state.kind === 'installed') return launch(state.entry);
  if (state.kind === 'collision') {
    throw new Error(
      `La carpeta de '${serverCfg.name}' (${serverInstallPath(options.installDir, serverCfg.name)}) ` +
        `pertenece al server '${state.owner}': sus nombres coinciden al sanitizarse. ` +
        'Renombra uno de los dos en .stratumrc.json.',
    );
  }

  const legacyEntry = state.kind === 'legacy' ? state.entry : null;
  const why = describeState(state, serverCfg.package);

  if (!options.autoInstall) {
    if (legacyEntry) {
      onLog?.(`[${serverCfg.name}] ${why}; se usa tal cual (autoInstall=false).`);
      return launch(legacyEntry);
    }
    throw new Error(
      `MCP server '${serverCfg.name}': ${why} y autoInstall=false. ` +
        `Ejecuta: stratum mcp install ${serverCfg.name}`,
    );
  }

  const dir = serverInstallPath(options.installDir, serverCfg.name);
  const failed = recentFailures.get(dir);
  if (failed && failed.spec === serverCfg.package && Date.now() - failed.at < FAILURE_BACKOFF_MS) {
    if (legacyEntry) return launch(legacyEntry);
    throw new Error(failed.message);
  }

  if (state.kind !== 'missing') onLog?.(`[${serverCfg.name}] ${why}: se reinstala.`);
  try {
    await installServer(serverCfg, options.installDir, onLog, installOpts);
    recentFailures.delete(dir);
  } catch (err) {
    const message = `No se pudo instalar el MCP server '${serverCfg.name}': ${(err as Error).message}`;
    recentFailures.set(dir, { spec: serverCfg.package, at: Date.now(), message });
    if (legacyEntry) {
      onLog?.(`[${serverCfg.name}] ${message}. Se usa la instalación anterior.`);
      return launch(legacyEntry);
    }
    throw new Error(message);
  }

  const after = installState(serverCfg, options.installDir);
  if (after.kind !== 'installed') {
    throw new Error(`MCP server '${serverCfg.name}': la instalación terminó pero no es válida.`);
  }
  return launch(after.entry);
}
