/**
 * Almacén de snapshots por proyecto y sesión (UX-1): un repo git en la sombra
 * cuyo work-tree es el proyecto del usuario, y el registro de turnos que
 * alimenta deshacer.
 *
 * Reglas de oro (brief UX-1):
 *  - El `.git` del usuario NUNCA se toca: todo ocurre en `~/.stratum/snapshots/<id>/`
 *    con GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE propios (ver `env.ts`).
 *  - Nunca lanza hacia el agente: cualquier fallo de git se registra en el log,
 *    desactiva los snapshots de esta sesión y el turno sigue igual.
 *  - Las escrituras del registro son atómicas y validadas con Zod (`registry.ts`).
 *
 * Un turno = snapshot T0 antes del loop + snapshot T1 en el `finally`; si los
 * árboles difieren, el diff (`diff-tree --name-status`/`--numstat`) entra en el
 * registro y `revertTurns()` puede devolver el work-tree al estado de T0.
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { lstat, readdir, rm, stat } from 'fs/promises';
import { isAbsolute, join, resolve, sep } from 'path';
import { hostname } from 'os';
import { createHash } from 'crypto';
import { findWorktreeRoot } from '../config/paths.js';
import type { SnapshotsConfig } from '../config/schema.js';
import { getLogger } from '../logging/index.js';
import { snapshotGitEnv } from './env.js';
import { snapshotDirForRoot } from './paths.js';
import {
  gitRun,
  isTreeHash,
  type GitRunOptions,
  mergeTreeDiff,
  parseNameStatusZ,
  parseNumstatZ,
  tail,
  type GitRunResult,
} from './git.js';
import {
  loadTurnsFile,
  saveTurnsFile,
  type TurnFileEntry,
  type TurnRecord,
} from './registry.js';

const log = getLogger('snapshots');

/** Rutas que jamás entran en un snapshot, aunque git no las ignore. */
const EXCLUDED_PREFIXES = ['.stratum/', '.git/'] as const;

/**
 * Ficheros de configuración/secretos que tampoco entran: `.stratumrc.json` y
 * cualquier `.stratumrc.*` pueden llevar apiKeys. Un snapshot se puede volcar
 * con `git cat-file` desde el almacén, así que no se copian.
 */
const EXCLUDED_BASENAMES = /^\.stratumrc(\..*)?$/;

/** Rutas por lote en `git checkout <T0> --pathspec-from-file=-` (revert). */
const RESTORE_BATCH = 500;

/**
 * Sufijo del ref que protege los árboles vivos. El gc es del repo de la sombra,
 * que es **compartido por todas las sesiones del proyecto**: sin refs, el gc de
 * una sesión podaría los árboles que otra necesita para deshacer.
 */
const KEEP_REF_PREFIX = 'refs/stratum/keep-';

/**
 * Atributos de TODOS los ficheros del repo de la sombra. `info/attributes` tiene
 * precedencia sobre los `.gitattributes` del work-tree, así que anula lo que
 * normalizaría los bytes al guardarlos y los cambiaría al restaurarlos
 * (`text`/`eol`, `working-tree-encoding`, `filter`, `ident`, merge drivers):
 * deshacer tiene que devolver los bytes exactos, no una versión reescrita.
 *
 * Deliberadamente **sin `-diff`**: marcar todo como binario haría que `--numstat`
 * devolviera `-` en cada fichero y el registro de turnos perdería
 * `additions`/`deletions` (número para texto, `undefined` solo para binarios de
 * verdad). Los drivers de diff no tocan los bytes almacenados.
 */
const SHADOW_ATTRIBUTES = '* -text -eol -filter -ident -merge -working-tree-encoding\n';

/** Ventana de gracia del gc: un T0 recién escrito aún no está en ningún registro. */
const PRUNE_WINDOW = '1.hour.ago';

/** Un lock del registro más viejo que esto es de un proceso que ya no está. */
const LOCK_STALE_MS = 2 * 60_000;

/** ¿Sigue vivo ese pid en este host? (`EPERM` = existe, pero es de otro usuario). */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface SnapshotStoreOptions {
  /** cwd del agente: se resuelve a la raíz del worktree (punto 3 del brief). */
  cwd: string;
  /** Id de sesión de `StratumAgent`: índice y registro van por sesión. */
  sessionId: string;
  /** Sección `snapshots` de la config (ya validada y con defaults). */
  config: SnapshotsConfig;
  /** Home inyectable para los tests: en tests nunca se escribe en el `~` real. */
  home?: string;
}

/** Fichero candidato que superó `maxFileBytes`: sin snapshot, no revertible. */
export interface SkippedPath {
  path: string;
  bytes: number;
  /** Necesario para saber si un fichero "skipped" cambió dentro del turno. */
  mtimeMs: number;
}

export interface SnapshotResult {
  /** Hash de árbol (`git write-tree`). */
  tree: string;
  /** Candidatos descartados por `maxFileBytes` en ESTA pasada. */
  skipped: SkippedPath[];
}

/** Un turno abierto con `beginTurn()`; cerrar con `finishTurn()`. */
export interface TrackedTurn {
  startedAt: string;
  before: SnapshotResult;
}

export interface RevertPlan {
  /** Números de turno que se revertirían (ascendentes). */
  turns: number[];
  /** Rutas que existían en el T0 del turno más antiguo: se restauran. */
  restore: string[];
  /** Rutas que no existían en ese T0: se borran del disco. */
  remove: string[];
  /** Rutas que el usuario (u otra cosa) tocó después del último turno revertido. */
  conflicts: string[];
  /** Rutas tocadas por esos turnos que no se pueden restaurar (> maxFileBytes). */
  skipped: string[];
}

export type RevertResult =
  | {
      ok: true;
      turns: number[];
      restored: string[];
      removed: string[];
      skipped: string[];
    }
  | {
      ok: false;
      reason: 'disabled' | 'turn-in-progress' | 'conflicts' | 'no-turns' | 'error';
      /** Con `reason: 'conflicts'`: las rutas en conflicto. */
      conflicts?: string[];
      /** Con `reason: 'error'`: descripción del fallo (git, rutas, registro). */
      error?: string;
      /**
       * Con `reason: 'error'` a media aplicación: lo que SÍ se llegó a hacer en
       * disco. El registro ya no contiene esos turnos (se persiste antes de
       * tocar ficheros), así que no se reinsertan.
       */
      applied?: { turns: number[]; restored: string[]; removed: string[] };
    };

/**
 * Aviso de un deshacer, para que abra el siguiente turno del agente (punto 7
 * del brief): el modelo tiene que saber que los ficheros que leyó ya no están
 * como los dejó, o reescribiría desde una versión que ya no existe.
 */
export function formatFilesReverted(
  turns: number[],
  restored: string[],
  removed: string[],
): string {
  const sentences = ['The user reverted the file changes of these turns.'];
  if (restored.length > 0) sentences.push(`Restored: ${restored.join(', ')}.`);
  if (removed.length > 0) sentences.push(`Removed: ${removed.join(', ')}.`);
  sentences.push('Re-read files before editing them.');
  return `<files_reverted turns="${turns.join(',')}">${sentences.join(' ')}</files_reverted>`;
}

/**
 * Id seguro para nombres de fichero, ref y lock: un id que ya es
 * `[A-Za-z0-9_-]+` se usa tal cual; cualquier otro se sanea **y** lleva un hash
 * corto del original, para que dos ids distintos que sanean igual
 * (`ses/a` y `ses?a`) no acaben compartiendo índice, registro y lock.
 */
function safeId(id: string): string {
  if (/^[A-Za-z0-9_-]{1,64}$/.test(id)) return id;
  const clean = id.replace(/[^\w-]+/g, '_').replace(/_+/g, '_').slice(0, 40) || 'session';
  const hash = createHash('sha256').update(id).digest('hex').slice(0, 8);
  return `${clean}-${hash}`;
}

function isExcludedPath(p: string): boolean {
  if (EXCLUDED_BASENAMES.test(p.slice(p.lastIndexOf('/') + 1))) return true;
  return EXCLUDED_PREFIXES.some((prefix) => p === prefix.slice(0, -1) || p.startsWith(prefix));
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export class SnapshotStore {
  /** Raíz absoluta del worktree del proyecto (work-tree del repo en la sombra). */
  readonly root: string;
  readonly sessionId: string;
  /** Directorio del almacén: `~/.stratum/snapshots/<id>/`. */
  readonly dir: string;
  /** GIT_DIR del repo en la sombra. */
  readonly gitDir: string;
  /** GIT_INDEX_FILE de esta sesión. */
  readonly indexFile: string;
  /** Registro de turnos de esta sesión. */
  readonly turnsFile: string;
  /** Lockfile del registro: exclusión entre procesos con el mismo `sessionId`. */
  readonly lockFile: string;
  readonly globalConfig: string;

  private readonly maxFileBytes: number;
  private readonly retentionDays: number;
  private readonly timeoutMs: number;
  private readonly maxFiles: number;
  /** T0 de los turnos en curso de ESTA sesión: el gc no puede podarlos. */
  private readonly liveTrees = new Set<string>();
  private readonly safeSession: string;

  private turns: TurnRecord[] = [];
  private nextTurn = 1;
  private active = false;
  private inFlight = 0;

  private constructor(opts: SnapshotStoreOptions, root: string) {
    this.root = root;
    this.sessionId = opts.sessionId;
    this.safeSession = safeId(opts.sessionId);
    this.maxFileBytes = opts.config.maxFileBytes;
    this.retentionDays = opts.config.retentionDays;
    this.timeoutMs = opts.config.timeoutMs;
    this.maxFiles = opts.config.maxFiles;
    this.dir = snapshotDirForRoot(root, opts.home);
    this.gitDir = join(this.dir, 'git');
    this.globalConfig = join(this.dir, 'empty.gitconfig');
    this.indexFile = join(this.dir, `index-${this.safeSession}`);
    this.turnsFile = join(this.dir, `turns-${this.safeSession}.json`);
    this.lockFile = join(this.dir, `turns-${this.safeSession}.lock`);
  }

  /** True si el almacén quedó operativo (init + registro ok). */
  isActive(): boolean {
    return this.active;
  }

  /** Motivo por el que está desactivado, para logs y diagnóstico. */
  get disabledReason(): string | undefined {
    return this.active ? undefined : this.reason;
  }
  private reason?: string;

  private disable(reason: string): void {
    if (this.active) {
      log.warn('snapshots disabled for this session', { root: this.root, reason });
    } else if (!this.reason) {
      log.warn('snapshots unavailable in this session', { root: this.root, reason });
    }
    // La primera causa es la que explica el desactivado; las siguientes son su
    // consecuencia (un snapshot que devuelve null porque ya estaba roto).
    if (!this.reason) this.reason = reason;
    this.active = false;
  }

  /**
   * Abre (y crea si hace falta) el almacén. Punto 1 y 3 del brief: solo se
   * activa si `snapshots.enabled` y el cwd está dentro de un repo git. Nunca
   * lanza: ante cualquier fallo devuelve un store desactivado.
   */
  static async open(opts: SnapshotStoreOptions): Promise<SnapshotStore> {
    // El work-tree es la RAÍZ del repo, no el cwd: si el agente se lanzó desde
    // una subcarpeta, el snapshot ha de cubrir el proyecto entero (y el id del
    // almacén, que se hashea de la raíz, ha de coincidir entre subcarpetas).
    const { worktree, isGitRepo } = findWorktreeRoot(resolve(opts.cwd));
    const store = new SnapshotStore(opts, worktree);

    if (!opts.config.enabled) {
      store.disable('snapshots.enabled is false');
      return store;
    }
    if (!isGitRepo) {
      store.disable('cwd is not inside a git repository');
      return store;
    }

    try {
      mkdirSync(join(store.gitDir, 'info'), { recursive: true });
      // `empty.gitconfig` ha de EXISTIR (GIT_CONFIG_GLOBAL apunta a él): si no,
      // git falla en cada invocación en vez de ignorarlo.
      writeFileSync(store.globalConfig, '', 'utf-8');
      // Idempotente en cada `open`: si el usuario creó un `.gitattributes`
      // después, esta escritura sigue ganando mientras el repo exista.
      store.ensureShadowAttributes();
    } catch (err) {
      store.disable(`cannot create snapshot dir: ${String(err)}`);
      return store;
    }

    if (!existsSync(join(store.gitDir, 'HEAD'))) {
      const ok = await store.initShadowRepo();
      if (!ok) return store; // initShadowRepo ya desactivó con su motivo
    }

    const loaded = loadTurnsFile(store.turnsFile);
    if (!loaded.ok) {
      // Corrupto o de una versión más nueva: no se toca el fichero y la sesión
      // va sin snapshots (reescribirlo perdería turnos).
      store.disable(`turns registry ${loaded.reason}`);
      return store;
    }
    store.turns = loaded.turns;
    const last = store.turns[store.turns.length - 1];
    store.nextTurn = (last?.turn ?? 0) + 1;

    await store.gc();
    store.active = true;
    return store;
  }

  /**
   * Todos los árboles vivos del proyecto: los `before`/`after` de **todas** las
   * sesiones (cada una escribe su `turns-<session>.json`) y los T0 de los turnos
   * en curso de esta. Una sesión con el registro incompatible no aporta nada: su
   * fichero no se puede leer, y sus árboles caen en la ventana de gracia del gc.
   */
  private async allLiveTrees(): Promise<Set<string>> {
    const trees = new Set<string>(this.liveTrees);
    const add = (turns: TurnRecord[]): void => {
      for (const turn of turns) {
        trees.add(turn.before);
        trees.add(turn.after);
      }
    };
    add(this.turns);
    let entries: string[] = [];
    try {
      entries = await readdir(this.dir);
    } catch {
      return trees;
    }
    for (const entry of entries) {
      if (!entry.startsWith('turns-') || !entry.endsWith('.json')) continue;
      const loaded = loadTurnsFile(join(this.dir, entry));
      if (loaded.ok) add(loaded.turns);
    }
    return trees;
  }

  /** Registro tal y como está en disco ahora mismo (vacío si no se puede leer). */
  private readTurnsFromDisk(): TurnRecord[] {
    const loaded = loadTurnsFile(this.turnsFile);
    return loaded.ok ? loaded.turns : this.turns;
  }

  /**
   * Lock del registro entre procesos con el mismo `sessionId` (dos CLI en el
   * mismo proyecto): un `turns-<id>.lock` creado con O_EXCL. Se roba si tiene
   * más de dos minutos o si el pid que lo escribió ya no existe en este host.
   * El registro se relee del disco **dentro** del lock y se fusiona por turno.
   * Si no se consigue en `timeoutMs`, se sigue sin lock (con warning): un lock
   * huérfano no puede colgar el turno del agente.
   */
  private async withTurnsLock<T>(fn: () => Promise<T> | T): Promise<T> {
    const deadline = Date.now() + this.timeoutMs;
    let held = false;
    while (!held) {
      try {
        const fd = openSync(this.lockFile, 'wx');
        try {
          writeFileSync(fd, JSON.stringify({ pid: process.pid, host: hostname(), at: Date.now() }));
        } finally {
          closeSync(fd);
        }
        held = true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        if (this.stealStaleLock()) continue;
        if (Date.now() > deadline) {
          log.warn('snapshot: turns registry lock is busy; writing without it', {
            lock: this.lockFile,
          });
          break;
        }
        await new Promise((done) => setTimeout(done, 25));
      }
    }
    try {
      return await fn();
    } finally {
      if (held) await rm(this.lockFile, { force: true }).catch(() => undefined);
    }
  }

  /** True si el lock era de un proceso muerto o demasiado viejo y se retiró. */
  private stealStaleLock(): boolean {
    let raw: { pid?: number; host?: string; at?: number };
    try {
      raw = JSON.parse(readFileSync(this.lockFile, 'utf-8')) as typeof raw;
    } catch {
      // Ilegible (o lo acaba de borrar su dueño): se reintenta como libre.
      unlinkSync(this.lockFile);
      return true;
    }
    const tooOld = typeof raw.at === 'number' && Date.now() - raw.at > LOCK_STALE_MS;
    const deadPeer =
      raw.host === hostname() && typeof raw.pid === 'number' && !isProcessAlive(raw.pid);
    if (!tooOld && !deadPeer) return false;
    log.warn('snapshot: stealing stale turns registry lock', { lock: this.lockFile, tooOld });
    unlinkSync(this.lockFile);
    return true;
  }

  /** `info/attributes` con los atributos duros de bytes. Solo escritura local. */
  private ensureShadowAttributes(): void {
    writeFileSync(join(this.gitDir, 'info', 'attributes'), SHADOW_ATTRIBUTES, 'utf-8');
  }

  /**
   * Única puerta de salida a git de esta clase: añade `snapshots.timeoutMs` y,
   * si una invocación se pasa de tiempo, desactiva los snapshots de la sesión.
   * El snapshot va en el camino crítico del turno: un git colgado no puede
   * dejar al agente esperando.
   */
  private async git(args: string[], opts: GitRunOptions): Promise<GitRunResult> {
    const result = await gitRun(args, { ...opts, timeoutMs: this.timeoutMs });
    if (result.timedOut) {
      this.disable(`git ${args[0] ?? ''} exceeded snapshots.timeoutMs (${this.timeoutMs} ms)`);
    }
    return result;
  }

  /** `git init` de la sombra + config dura. Solo la primera vez. */
  private async initShadowRepo(): Promise<boolean> {
    const env = this.envFor();
    let result = await this.git(['init', '--quiet'], { cwd: this.root, env });
    if (!result.ok) {
      this.disable(`git init failed: ${tail(result.stderr)}`);
      return false;
    }
    for (const [key, value] of [
      ['core.autocrlf', 'false'],
      ['core.safecrlf', 'false'],
      ['core.longpaths', 'true'],
      ['core.quotepath', 'false'],
      ['gc.auto', '0'],
    ] as const) {
      result = await this.git(['config', key, value], { cwd: this.root, env });
      if (!result.ok) {
        this.disable(`git config ${key} failed: ${tail(result.stderr)}`);
        return false;
      }
    }
    return true;
  }

  /** Entorno cerrado de `env.ts`, con el índice (por defecto, el de la sesión). */
  private envFor(indexFile: string = this.indexFile): NodeJS.ProcessEnv {
    return snapshotGitEnv({
      gitDir: this.gitDir,
      workTree: this.root,
      indexFile,
      globalConfig: this.globalConfig,
    });
  }

  // -------------------------------------------------------------------------
  // Snapshot de una pasada (T0 / T1): ls-files → add → write-tree
  // -------------------------------------------------------------------------

  /**
   * Un snapshot AHORA en el índice de la sesión: candidatos (`ls-files -z
   * --others --modified --deleted --exclude-standard`), descarte de `.stratum/`
   * y `.git/`, descarte de los que superan `maxFileBytes` (→ `skipped`), `git
   * add -A --pathspec-from-file` y `git write-tree`. La primera pasada de una
   * sesión parte de un índice vacío, así que los candidatos son todo el
   * proyecto no ignorado: eso es el «seed» del punto 4 del brief. Mide y
   * registra su tiempo (punto 6). Devuelve `null` si git falla.
   */
  async track(): Promise<SnapshotResult | null> {
    if (!this.active) return null;
    try {
      return await this.snapshotTo(this.indexFile);
    } catch (err) {
      this.disable(`track failed: ${String(err)}`);
      return null;
    }
  }

  private async snapshotTo(indexFile: string): Promise<SnapshotResult | null> {
    return this.snapshotWith(this.envFor(indexFile));
  }

  /** Candidatos + `add` + `write-tree` sobre el índice que diga `env`. */
  private async snapshotWith(env: NodeJS.ProcessEnv): Promise<SnapshotResult | null> {
    const timer = log.startTimer();

    let collected = await this.collectCandidates(env);
    if (!collected) return null;
    if (collected.addPaths.length > 0 && !(await this.addCandidates(env, collected.addPaths)).ok) {
      // Carrera típica: un fichero listado desapareció entre ls-files y add.
      // Se recalculan los candidatos una vez y se reintenta.
      collected = await this.collectCandidates(env);
      if (!collected) return null;
      if (
        collected.addPaths.length > 0 &&
        !(await this.addCandidates(env, collected.addPaths)).ok
      ) {
        return null;
      }
    }
    const written = await this.git(['write-tree'], { cwd: this.root, env });
    if (!written.ok || !isTreeHash(written.stdout.trim())) {
      log.warn('snapshot: git write-tree failed', { stderr: tail(written.stderr) });
      return null;
    }
    const skipped = collected.skipped.sort((a, b) => a.path.localeCompare(b.path));
    log.debug('snapshot track', {
      durationMs: timer(),
      files: collected.addPaths.length,
      skipped: skipped.length,
    });
    return { tree: written.stdout.trim(), skipped };
  }

  /** Candidatos de `ls-files` filtrados (excluidos y tamaño). Nunca lanza. */
  private async collectCandidates(
    env: NodeJS.ProcessEnv,
  ): Promise<{ addPaths: string[]; skipped: SkippedPath[] } | null> {
    const listed = await this.git(
      ['ls-files', '-z', '--others', '--modified', '--deleted', '--exclude-standard'],
      { cwd: this.root, env },
    );
    if (!listed.ok) {
      log.warn('snapshot: git ls-files failed', { stderr: tail(listed.stderr) });
      return null;
    }
    const seen = new Set<string>();
    const paths: string[] = [];
    for (const entry of listed.stdout.split('\0')) {
      if (!entry || isExcludedPath(entry) || seen.has(entry)) continue;
      seen.add(entry);
      paths.push(entry);
    }

    // Un proyecto que no es un proyecto (home, monorepo sin .gitignore) no se
    // recorre: la sesión se queda sin snapshots en vez de pagar el coste.
    if (paths.length > this.maxFiles) {
      log.warn('snapshot: too many candidate files; snapshots disabled', {
        candidates: paths.length,
        maxFiles: this.maxFiles,
        root: this.root,
      });
      this.disable(
        `snapshot has ${paths.length} candidate files, over snapshots.maxFiles (${this.maxFiles})`,
      );
      return null;
    }

    const addPaths: string[] = [];
    const skipped: SkippedPath[] = [];
    const CHUNK = 256;
    for (let i = 0; i < paths.length; i += CHUNK) {
      await Promise.all(
        paths.slice(i, i + CHUNK).map(async (path) => {
          let info;
          try {
            info = await stat(join(this.root, path));
          } catch {
            // Desapareció tras el listado: si estaba en el índice, `add` stagea
            // el borrado; si era untracked de carrera, el reintento lo cubre.
            addPaths.push(path);
            return;
          }
          if (info.isFile() && info.size > this.maxFileBytes) {
            skipped.push({ path, bytes: info.size, mtimeMs: info.mtimeMs });
            return;
          }
          addPaths.push(path);
        }),
      );
    }
    addPaths.sort((a, b) => a.localeCompare(b));
    return { addPaths, skipped };
  }

  /**
   * `git add -A` de los candidatos vía pathspec file (NUL). El entorno lleva
   * `GIT_LITERAL_PATHSPECS=1`, así que cada entrada es una ruta literal (nada de
   * globbing ni de magia `:(exclude)`): las exclusiones ya se aplicaron al
   * listado, en `collectCandidates`.
   */
  private async addCandidates(env: NodeJS.ProcessEnv, paths: string[]): Promise<GitRunResult> {
    const result = await this.git(['add', '-A', '--pathspec-from-file=-', '--pathspec-file-nul'], {
      cwd: this.root,
      env,
      input: paths.join('\0'),
    });
    if (!result.ok) {
      log.warn('snapshot: git add failed', {
        exitCode: result.exitCode,
        files: paths.length,
        stderr: tail(result.stderr),
      });
    }
    return result;
  }

  // -------------------------------------------------------------------------
  // Ciclo por turno (punto 5): T0 antes del loop, T1 en el finally
  // -------------------------------------------------------------------------

  /**
   * Toma el snapshot T0 del turno y marca el turno como en curso (bloquea
   * `revertTurns`). Devuelve `null` si los snapshots están desactivados o el
   * snapshot falló (en cuyo caso los desactiva para la sesión).
   */
  async beginTurn(): Promise<TrackedTurn | null> {
    if (!this.active) return null;
    try {
      const before = await this.snapshotTo(this.indexFile);
      if (!before) {
        this.disable('turn snapshot failed');
        return null;
      }
      this.inFlight++;
      // El T0 de un turno en curso no está en ningún registro todavía: el gc de
      // otra sesión lo vería huérfano, así que se protege aquí.
      this.liveTrees.add(before.tree);
      return { startedAt: new Date().toISOString(), before };
    } catch (err) {
      this.disable(`turn snapshot failed: ${String(err)}`);
      return null;
    }
  }

  /**
   * T1 + diff + registro. Sin cambios (T0 == T1) no se registra nada. Nunca
   * lanza; un fallo aquí desactiva los snapshots de la sesión y el turno sigue.
   */
  async finishTurn(tracked: TrackedTurn | null, endedAt: string = new Date().toISOString()): Promise<TurnRecord | null> {
    if (!tracked) return null;
    try {
      if (!this.active) return null;
      const after = await this.snapshotTo(this.indexFile);
      if (!after) {
        this.disable('turn snapshot failed');
        return null;
      }
      if (after.tree === tracked.before.tree) return null; // turno sin cambios
      const files = await this.diffTrees(tracked.before.tree, after.tree);
      if (!files) {
        this.disable('turn diff failed');
        return null;
      }
      const skipped = await this.computeTurnSkipped(tracked.before.skipped, after.skipped);
      let record: TurnRecord;
      try {
        // Dentro del lock y releyendo el disco: otro proceso con el mismo
        // `sessionId` puede haber añadido turnos mientras corría el loop.
        record = await this.withTurnsLock(async () => {
          const disk = this.readTurnsFromDisk();
          const turn = Math.max(0, ...disk.map((t) => t.turn)) + 1;
          const next: TurnRecord = {
            turn,
            startedAt: tracked.startedAt,
            endedAt,
            before: tracked.before.tree,
            after: after.tree,
            files,
            skipped,
          };
          // Fusión por turno: lo que haya en disco manda para los demás turnos.
          const merged = [...disk.filter((t) => t.turn !== turn), next].sort(
            (a, b) => a.turn - b.turn,
          );
          saveTurnsFile(this.turnsFile, merged);
          this.turns = merged;
          this.nextTurn = turn + 1;
          return next;
        });
      } catch (err) {
        this.disable(`cannot save turns registry: ${String(err)}`);
        return null;
      }
      log.info('turn recorded', {
        turn: record.turn,
        files: record.files.length,
        skipped: record.skipped.length,
      });
      return record;
    } catch (err) {
      // Un fallo auxiliar nunca es un error del agente (punto 6): se registra,
      // se desactivan los snapshots de la sesión y el turno sigue igual.
      this.disable(`turn snapshot failed: ${String(err)}`);
      return null;
    } finally {
      this.inFlight--;
      this.liveTrees.delete(tracked.before.tree);
    }
  }

  /** Diff `added|modified|deleted` + numstat entre dos árboles de la sombra. */
  private async diffTrees(t0: string, t1: string): Promise<TurnFileEntry[] | null> {
    const base = ['-r', '-z', '--no-renames'];
    const [names, nums] = await Promise.all([
      this.git(['diff-tree', ...base, '--name-status', t0, t1], {
        cwd: this.root,
        env: this.envFor(),
      }),
      this.git(['diff-tree', ...base, '--numstat', t0, t1], {
        cwd: this.root,
        env: this.envFor(),
      }),
    ]);
    if (!names.ok || !nums.ok) {
      log.warn('snapshot: diff-tree failed', {
        stderr: tail(names.ok ? nums.stderr : names.stderr),
      });
      return null;
    }
    return mergeTreeDiff(parseNameStatusZ(names.stdout), parseNumstatZ(nums.stdout));
  }

  /**
   * Los ficheros `skipped` (> maxFileBytes) no están en ningún árbol, así que
   * el diff no los ve: se detectan comparando su stat entre T0 y T1 (nuevo o
   * modificado), y los que existían en T0 y faltan ahora (borrados).
   */
  private async computeTurnSkipped(
    before: SkippedPath[],
    after: SkippedPath[],
  ): Promise<string[]> {
    const beforeMap = new Map(before.map((s) => [s.path, s]));
    const afterSet = new Set(after.map((s) => s.path));
    const out: string[] = [];
    for (const s of after) {
      const prev = beforeMap.get(s.path);
      if (!prev || prev.bytes !== s.bytes || prev.mtimeMs !== s.mtimeMs) out.push(s.path);
    }
    for (const prev of before) {
      if (afterSet.has(prev.path)) continue;
      // ¿Borrado durante el turno, o se quedó pequeño y entró en el diff?
      try {
        await stat(join(this.root, prev.path));
      } catch {
        out.push(prev.path);
      }
    }
    return out.sort((a, b) => a.localeCompare(b));
  }

  // -------------------------------------------------------------------------
  // Deshacer (punto 7, a nivel de módulo; la fachada en `StratumAgent` es fase 2)
  // -------------------------------------------------------------------------

  /** Turnos deshacibles, el más reciente primero. */
  getUndoableTurns(): TurnRecord[] {
    return [...this.turns].reverse();
  }

  /**
   * Plan para revertir los `count` últimos turnos: unión de sus diffs llevada
   * al estado del T0 del turno MÁS ANTIGUO. Conflicto = ruta cuyo contenido
   * actual difiere del T1 del turno más reciente (se comprueba con un snapshot
   * actual en un índice temporal, nunca tocando el de la sesión).
   */
  async planRevert(count = 1): Promise<RevertPlan> {
    const empty: RevertPlan = { turns: [], restore: [], remove: [], conflicts: [], skipped: [] };
    if (!this.active) return empty;
    try {
      return await this.buildRevertPlan(count);
    } catch (err) {
      // Nunca lanza hacia la UI: un plan vacío se lee como «no hay nada que
      // deshacer», que es la dirección segura.
      log.warn('snapshot: planRevert failed', { err });
      return empty;
    }
  }

  private async buildRevertPlan(count: number): Promise<RevertPlan> {
    const selected = this.turns.slice(-Math.max(1, Math.floor(count)));
    if (selected.length === 0) {
      return { turns: [], restore: [], remove: [], conflicts: [], skipped: [] };
    }

    // Unión de rutas: el estado de la ruta en el turno más antiguo decide
    // restore (existía en su T0) o remove (no existía).
    const restore: string[] = [];
    const remove: string[] = [];
    const allPaths = new Set<string>();
    for (const turn of selected) {
      for (const file of turn.files) {
        if (allPaths.has(file.path)) continue;
        allPaths.add(file.path);
        (file.status === 'added' ? remove : restore).push(file.path);
      }
    }
    const skipped = [...new Set(selected.flatMap((t) => t.skipped))];
    const conflicts = await this.detectConflicts(selected[selected.length - 1]!.after, allPaths);
    return { turns: selected.map((t) => t.turn), restore, remove, conflicts, skipped };
  }

  /**
   * Rutas que cambiaron respecto al T1 del último turno: snapshot actual en un
   * índice temporal + diff de árboles, cruzado con las rutas a revertir. Sin
   * pathspec en la línea de comandos: `git diff` no soporta
   * `--pathspec-from-file` y los pathspecs de argv harían globbing de rutas con
   * `*` o `[]`. Ante cualquier fallo de git devuelve TODAS las rutas como
   * conflicto: es la dirección segura (bloquea el revert sin `force`, nunca
   * revierte de más).
   */
  private async detectConflicts(t1: string, paths: Set<string>): Promise<string[]> {
    if (paths.size === 0) return [];
    const tmpIndex = join(this.dir, `index-tmp-${process.pid}-${Date.now()}`);
    const env = this.envFor(tmpIndex);
    try {
      // El índice temporal parte del árbol T1 (`read-tree`): así `ls-files`
      // solo lista lo que cambió desde el turno y no se re-hashea el proyecto.
      const read = await this.git(['read-tree', t1], { cwd: this.root, env });
      if (!read.ok) {
        log.warn('snapshot: conflict check could not read T1', { stderr: tail(read.stderr) });
        return [...paths];
      }
      const now = await this.snapshotWith(env);
      if (!now) {
        log.warn('snapshot: conflict check could not snapshot current state');
        return [...paths];
      }
      const entries = await this.diffTrees(t1, now.tree);
      if (!entries) {
        log.warn('snapshot: conflict check failed; assuming conflicts');
        return [...paths];
      }
      const changed = new Set(entries.map((e) => e.path));
      return [...paths].filter((p) => changed.has(p));
    } finally {
      await rm(tmpIndex, { force: true }).catch(() => undefined);
    }
  }

  /**
   * Revierte los `count` últimos turnos. Rechaza (resultado con error, sin
   * excepción) si hay un turno en curso o si hay conflictos sin `force`.
   * Restaura con `git checkout <T0> --pathspec-from-file` en lotes y borra las
   * rutas `remove`; después las quita del registro.
   */
  async revertTurns(count = 1, opts: { force?: boolean } = {}): Promise<RevertResult> {
    if (!this.active) return { ok: false, reason: 'disabled' };
    if (this.inFlight > 0) return { ok: false, reason: 'turn-in-progress' };
    try {
      return await this.applyRevert(count, opts);
    } catch (err) {
      // Resultado con error, nunca excepción: el llamador (chat/CLI) decide.
      log.warn('snapshot: revertTurns failed', { err });
      return { ok: false, reason: 'error', error: String(err) };
    }
  }

  private async applyRevert(count: number, opts: { force?: boolean }): Promise<RevertResult> {
    const plan = await this.buildRevertPlan(count);
    if (plan.turns.length === 0) return { ok: false, reason: 'no-turns' };
    if (plan.conflicts.length > 0 && !opts.force) {
      return { ok: false, reason: 'conflicts', conflicts: plan.conflicts };
    }

    // Confinamiento: el registro es un fichero de disco y podría estar editado a
    // mano o venir de otra versión. Nada se toca hasta validar TODAS las rutas.
    const unsafe = [...plan.restore, ...plan.remove].filter((p) => !this.isSafeRelativePath(p));
    if (unsafe.length > 0) {
      log.warn('snapshot: revert rejected, unsafe paths in turn record', { unsafe });
      return {
        ok: false,
        reason: 'error',
        error: `unsafe path in turn record: ${unsafe.join(', ')}`,
      };
    }

    const oldest = this.turns.find((t) => t.turn === plan.turns[0]);
    if (!oldest) return { ok: false, reason: 'error', error: 'turn record disappeared' };

    // 1) Registro primero: si el proceso muere a mitad de aplicar, los turnos
    //    ya no figuran como deshacibles (nunca se reinsertan a medias).
    const drop = new Set(plan.turns);
    try {
      await this.withTurnsLock(async () => {
        const disk = this.readTurnsFromDisk();
        const merged = disk.filter((t) => !drop.has(t.turn));
        saveTurnsFile(this.turnsFile, merged);
        this.turns = merged;
      });
    } catch (err) {
      return { ok: false, reason: 'error', error: `cannot save turns registry: ${String(err)}` };
    }

    // 2) Y después, el disco.
    const env = this.envFor();
    const restored: string[] = [];
    const removed: string[] = [];
    const failed = (error: string): RevertResult => ({
      ok: false,
      reason: 'error',
      error,
      applied: { turns: plan.turns, restored, removed },
    });

    for (const batch of chunk(plan.restore, RESTORE_BATCH)) {
      const result = await this.git(
        ['checkout', oldest.before, '--pathspec-from-file=-', '--pathspec-file-nul'],
        { cwd: this.root, env, input: batch.join(' ') },
      );
      if (!result.ok) {
        log.warn('snapshot: revert restore failed; registry already updated', {
          stderr: tail(result.stderr),
        });
        return failed(`git checkout failed: ${tail(result.stderr)}`);
      }
      restored.push(...batch);
    }

    for (const path of plan.remove) {
      const abs = join(this.root, path);
      try {
        // `lstat` (no `stat`): un symlink se borra como enlace, nunca su destino.
        const info = await lstat(abs);
        if (info.isDirectory() && !info.isSymbolicLink()) {
          // Nunca se borra un directorio: la ruta del registro era un fichero.
          return failed(`refusing to remove a directory: ${path}`);
        }
        await rm(abs, { force: true });
        removed.push(path);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          removed.push(path); // ya no estaba: el objetivo del revert se cumple
          continue;
        }
        return failed(`cannot remove ${path}: ${String(err)}`);
      }
    }

    // El índice de la sesión aún contiene lo borrado: stagear el borrado o el
    // próximo turno lo registraría como una eliminación fantasma del agente.
    if (removed.length > 0) {
      const staged = await this.addCandidates(env, removed);
      if (!staged.ok) {
        log.warn('snapshot: staging removals failed; session index may be stale', {
          stderr: tail(staged.stderr),
        });
      }
    }

    log.info('turns reverted', {
      turns: plan.turns.join(','),
      restored: restored.length,
      removed: removed.length,
    });
    return { ok: true, turns: plan.turns, restored, removed, skipped: plan.skipped };
  }

  /**
   * ¿Es una ruta relativa al work-tree y sigue dentro de él? Rechaza absolutas,
   * con `..`, con `:` (unidades de Windows y flujos alternativos) y con NUL.
   */
  private isSafeRelativePath(p: string): boolean {
    if (!p || p.includes(' ') || p.includes(':')) return false;
    if (isAbsolute(p)) return false;
    if (p.split(/[\/]+/).includes('..')) return false;
    const base = this.root.endsWith(sep) ? this.root : this.root + sep;
    return resolve(this.root, p).startsWith(base);
  }

  // -------------------------------------------------------------------------
  // GC (punto 8)
  // -------------------------------------------------------------------------

  /**
   * Purga los turnos más viejos que `retentionDays` y, si borró algo, protege
   * los árboles de los turnos vivos con un ref y lanza `git gc --prune=now`
   * en segundo plano SIN esperar (fallo ignorado). El ref es imprescindible:
   * los árboles de write-tree no cuelgan de ningún commit, así que sin él el
   * gc borraría también los turnos que siguen deshacibles.
   */
  private async gc(): Promise<void> {
    if (this.retentionDays <= 0 || this.turns.length === 0) return;
    const cutoff = Date.now() - this.retentionDays * 86_400_000;
    const expired = (turn: TurnRecord): boolean => {
      const end = Date.parse(turn.endedAt);
      return Number.isFinite(end) && end < cutoff;
    };
    if (!this.turns.some(expired)) return;
    try {
      await this.withTurnsLock(async () => {
        // Releer: otra sesión/proceso pudo añadir turnos entre medias.
        const disk = this.readTurnsFromDisk();
        const kept = disk.filter((t) => !expired(t));
        saveTurnsFile(this.turnsFile, kept);
        this.turns = kept;
        const last = kept[kept.length - 1];
        this.nextTurn = (last?.turn ?? 0) + 1;
      });
    } catch (err) {
      log.warn('snapshot gc: cannot save purged registry; gc skipped', { err });
      return;
    }
    try {
      await this.protectLiveTrees();
    } catch (err) {
      // Sin los refs, el gc podaría turnos vivos (de esta sesión o de otra):
      // mejor no hacer gc.
      log.warn('snapshot gc: could not protect live trees; gc skipped', { err });
      return;
    }
    // Fire and forget: el fallo del gc se ignora (punto 8) y nunca bloquea.
    void this.git(['gc', `--prune=${PRUNE_WINDOW}`, '--quiet'], {
      cwd: this.root,
      env: this.envFor(),
    })
      .then((result) => {
        if (!result.ok) log.debug('snapshot gc finished with error', { exitCode: result.exitCode });
      })
      .catch(() => undefined);
  }

  /**
   * Un commit sintético con los árboles vivos como entradas, pineado en un ref
   * por sesión: los hace alcanzables para el gc. El commit se reconstruye en
   * cada gc, así que el ref nunca protege más que los turnos actuales.
   */
  private async protectLiveTrees(): Promise<void> {
    const ref = `${KEEP_REF_PREFIX}${this.safeSession}`;
    // El repo de la sombra es del PROYECTO, no de la sesión: el gc de esta
    // sesión podaría los árboles que otra necesita para deshacer. Se protege la
    // unión de todos los `turns-*.json` del directorio más los T0 en curso.
    const trees = [...(await this.allLiveTrees())].sort();
    if (trees.length === 0) {
      await this.git(['update-ref', '-d', ref], { cwd: this.root, env: this.envFor() });
      return;
    }
    const ident = this.envFor();
    ident.GIT_AUTHOR_NAME = 'Stratum';
    ident.GIT_AUTHOR_EMAIL = 'snapshots@stratum.local';
    ident.GIT_COMMITTER_NAME = 'Stratum';
    ident.GIT_COMMITTER_EMAIL = 'snapshots@stratum.local';
    const now = new Date().toISOString();
    ident.GIT_AUTHOR_DATE = now;
    ident.GIT_COMMITTER_DATE = now;

    const lines = trees.map((hash, i) => `040000 tree ${hash}\tkeep-${String(i).padStart(8, '0')}`);
    const tree = await this.git(['mktree'], { cwd: this.root, env: ident, input: lines.join('\n') + '\n' });
    if (!tree.ok) throw new Error(`mktree failed: ${tail(tree.stderr)}`);
    const commit = await this.git(['commit-tree', tree.stdout.trim()], {
      cwd: this.root,
      env: ident,
      input: 'stratum snapshot gc keep\n',
    });
    if (!commit.ok) throw new Error(`commit-tree failed: ${tail(commit.stderr)}`);
    const updated = await this.git(['update-ref', ref, commit.stdout.trim()], {
      cwd: this.root,
      env: ident,
    });
    if (!updated.ok) throw new Error(`update-ref failed: ${tail(updated.stderr)}`);
  }
}
