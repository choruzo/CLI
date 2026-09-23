import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import { rm } from 'fs/promises';
import { homedir } from 'os';
import { extname, isAbsolute, join, parse, resolve, sep } from 'path';
import type { StratumConfig } from '../config/schema.js';
import type { WorkspaceConfinement } from '../agent/types.js';
import { confinePath } from '../tools/fs/confine.js';
import { getLogger } from '../logging/index.js';
import { isConversationId } from './session-store.js';
import type { WorkspaceFileInfo, WorkspaceStatus } from './protocol.js';
import { extractArchive, packDirectory, verifyArchive } from './archive.js';

/**
 * Espacio de trabajo de cada conversación del modo Chat (Stratum Desktop D2):
 *
 * ```
 * <root>/<conversationId>/
 *   inputs/          ← copias de lo que sube el usuario (las hace Rust; solo lectura para el agente)
 *   outputs/         ← lo que el agente genera para el usuario
 *   scratch/         ← ficheros intermedios del agente
 *   .workspace.json  ← metadatos (creado, último uso, estado, tamaño, fijado)
 * ```
 *
 * El sidecar es el único escritor de `.workspace.json` (escritura atómica, como
 * el resto de stores). Rust solo copia en `inputs/` y avisa con
 * `workspace_touch`; el agente no puede escribir fuera de `outputs/` y
 * `scratch/` (`WorkspaceConfinement.writable`).
 *
 * Retención (D3). Un workspace sin uso se archiva y luego se purga; lo que
 * queda en la raíz en cada estado:
 *
 * ```
 * active    <id>/                        (con su .workspace.json)
 * archived  <id>.tar.gz + <id>.json      (registro de retención)
 * purged    <id>.json                    (solo el registro: la conversación sigue)
 * ```
 *
 * El orden de cada operación deja siempre un estado reconocible si el proceso
 * muere a mitad (`inspect`): **la carpeta gana** —solo desaparece renombrándola
 * a `.trash-*` cuando el archivo ya está completo, verificado y registrado—, y
 * un registro `purged` es terminal. Los temporales (`.tmp-*`, `.restoring-*`,
 * `.trash-*`) se barren en `recover()`.
 */

const log = getLogger('desktop.workspace');

export const WORKSPACE_DIRS = { inputs: 'inputs', outputs: 'outputs', scratch: 'scratch' } as const;
export const WORKSPACE_META_FILE = '.workspace.json';
export const WORKSPACE_META_VERSION = 1;

/** Cuántos ficheros de `outputs/` se anuncian por turno como mucho. */
const MAX_REPORTED_OUTPUTS = 50;
/** Tope del recorrido de `outputs/` (un agente que genera miles de ficheros no bloquea el sidecar). */
const MAX_WALK_ENTRIES = 5_000;

export interface WorkspaceMeta {
  version: number;
  conversationId: string;
  createdAt: string;
  /** Último uso real: un turno o una subida. Abrir la conversación no cuenta (D3). */
  lastUsedAt: string;
  /** Dentro de la carpeta siempre `active`; los otros estados viven en el registro. */
  state: 'active';
  sizeBytes: number;
  /** Excluido de la retención (16.7). */
  pinned: boolean;
  /**
   * Los ficheros anteriores a esta fecha se purgaron: la conversación siguió
   * con un workspace nuevo (D3). Ausente si nunca hubo purga.
   */
  filesExpiredAt?: string;
}

/** Registro de retención (`<root>/<id>.json`) de un workspace sin carpeta. */
export interface RetentionRecord {
  version: number;
  conversationId: string;
  state: 'archived' | 'purged';
  createdAt: string;
  lastUsedAt: string;
  pinned: boolean;
  sizeBytes: number;
  filesExpiredAt?: string;
  archivedAt?: string;
  archiveBytes?: number;
  purgedAt?: string;
}

export interface WorkspaceSettings {
  root: string;
  maxFileBytes: number;
  maxWorkspaceBytes: number;
  /** Sin uso durante este tiempo → `archived`. `0` o ausente: nunca. */
  compressAfterMs?: number;
  /** Sin uso durante este tiempo → `purged`. `0` o ausente: nunca. */
  deleteAfterMs?: number;
}

const MB = 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Resuelve `desktop.workspaces` de la config. La raíz puede ser cualquier ruta
 * absoluta (decisión de producto: moverla a otro disco); se rechazan las
 * relativas —dependerían del cwd del sidecar—, la raíz de una unidad y el home
 * o un ancestro suyo, donde D3 acabaría purgando junto a carpetas del usuario.
 * Nunca lanza: una raíz inválida se avisa y se usa el default.
 */
export function resolveWorkspaceSettings(
  config: StratumConfig,
  dataDir: string,
  home: string = homedir(),
): { settings: WorkspaceSettings; warning: string | null } {
  const w = config.desktop.workspaces;
  const fallback = join(dataDir, 'workspaces');
  let root = fallback;
  let warning: string | null = null;
  if (w.root !== undefined && w.root.trim() !== '') {
    const raw = w.root.trim();
    const expanded = raw === '~' || /^~[\\/]/.test(raw) ? join(home, raw.slice(1)) : raw;
    const problem = workspaceRootProblem(expanded, home);
    if (problem) {
      warning = `desktop.workspaces.root "${raw}" no es válida (${problem}); se usa ${fallback}`;
    } else {
      root = resolve(expanded);
    }
  }
  return {
    settings: {
      root,
      maxFileBytes: Math.floor(w.maxFileMB * MB),
      maxWorkspaceBytes: Math.floor(w.maxWorkspaceMB * MB),
      compressAfterMs: Math.floor(w.compressAfterDays * DAY_MS),
      deleteAfterMs: Math.floor(w.deleteAfterDays * DAY_MS),
    },
    warning,
  };
}

function workspaceRootProblem(path: string, home: string): string | null {
  if (!isAbsolute(path)) return 'tiene que ser una ruta absoluta';
  const abs = resolve(path);
  if (parse(abs).root === abs || parse(abs).root === `${abs}${sep}`) {
    return 'no puede ser la raíz de una unidad';
  }
  const norm = (p: string): string => {
    const r = resolve(p) + sep;
    return process.platform === 'win32' ? r.toLowerCase() : r;
  };
  if (norm(home).startsWith(norm(abs)))
    return 'no puede ser el home ni una carpeta que lo contenga';
  return null;
}

const MIME_BY_EXT: Record<string, string> = {
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.zip': 'application/zip',
};

export function mimeFor(name: string): string {
  return MIME_BY_EXT[extname(name).toLowerCase()] ?? 'application/octet-stream';
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < MB) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / MB).toFixed(1)} MB`;
}

interface Stamp {
  size: number;
  mtimeMs: number;
}

/**
 * Recorre `dir` sin seguir enlaces: un symlink o una junction dentro del
 * workspace no puede hacer que se midan o anuncien ficheros de fuera.
 */
function walkFiles(dir: string, relDir: string, out: Map<string, Stamp>, budget: { n: number }) {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (budget.n-- <= 0) return;
    const full = join(dir, entry);
    const rel = relDir ? `${relDir}/${entry}` : entry;
    let st;
    try {
      st = lstatSync(full);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) walkFiles(full, rel, out, budget);
    else if (st.isFile()) out.set(rel, { size: st.size, mtimeMs: st.mtimeMs });
  }
}

export type OutputsSnapshot = Map<string, Stamp>;

export type AttachmentCheck =
  | { ok: true; path: string; size: number; mime: string }
  | { ok: false; reason: string };

const isIso = (v: unknown): v is string => typeof v === 'string' && !Number.isNaN(Date.parse(v));

function writeJsonAtomic(path: string, data: unknown): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
  renameSync(tmp, path);
}

/**
 * Estado de retención visto por la UI. `purgeAt` es cuándo se borrarán los
 * ficheros si nadie usa la conversación antes; `null` si está fijada o la purga
 * está desactivada.
 */
export function workspaceStatus(
  state: WorkspaceStatus['state'],
  fields: { lastUsedAt: string; pinned: boolean; filesExpiredAt?: string; sizeBytes: number },
  settings: WorkspaceSettings,
): WorkspaceStatus {
  const deleteAfter = settings.deleteAfterMs ?? 0;
  const purgeAt =
    !fields.pinned && deleteAfter > 0 && state !== 'purged'
      ? new Date(Date.parse(fields.lastUsedAt) + deleteAfter).toISOString()
      : null;
  return {
    state,
    pinned: fields.pinned,
    lastUsedAt: fields.lastUsedAt,
    purgeAt,
    filesExpiredAt: fields.filesExpiredAt ?? null,
    // Tras la purga no queda nada, aunque el registro guarde el tamaño de antes.
    sizeBytes: state === 'purged' ? 0 : fields.sizeBytes,
  };
}

/** El workspace de una conversación, ya creado en disco. */
export class ConversationWorkspace {
  readonly confinement: WorkspaceConfinement;
  private meta: WorkspaceMeta;

  /**
   * Crea las subcarpetas y carga (o genera) los metadatos. Abrir **no** marca
   * uso (D3): solo recalcula el tamaño. `initial` siembra los metadatos de un
   * workspace nuevo (el que sustituye a uno purgado).
   */
  constructor(
    readonly conversationId: string,
    readonly dir: string,
    private readonly now: () => Date,
    initial: Partial<Pick<WorkspaceMeta, 'filesExpiredAt' | 'pinned'>> = {},
  ) {
    this.confinement = {
      root: dir,
      readOnly: [WORKSPACE_DIRS.inputs],
      writable: [WORKSPACE_DIRS.outputs, WORKSPACE_DIRS.scratch],
    };
    for (const sub of Object.values(WORKSPACE_DIRS)) mkdirSync(join(dir, sub), { recursive: true });
    this.meta = this.loadMeta() ?? { ...this.freshMeta(), ...initial };
    this.refresh();
  }

  private get metaPath(): string {
    return join(this.dir, WORKSPACE_META_FILE);
  }

  private freshMeta(): WorkspaceMeta {
    const iso = this.now().toISOString();
    return {
      version: WORKSPACE_META_VERSION,
      conversationId: this.conversationId,
      createdAt: iso,
      lastUsedAt: iso,
      state: 'active',
      sizeBytes: 0,
      pinned: false,
    };
  }

  /** Metadatos existentes, o `null` si faltan o no se pueden leer (se regeneran). */
  private loadMeta(): WorkspaceMeta | null {
    const meta = readWorkspaceMeta(this.dir, this.conversationId);
    if (meta === null) {
      log.warn('workspace metadata unreadable; regenerating', {
        conversationId: this.conversationId,
      });
    }
    return meta ?? null;
  }

  getMeta(): WorkspaceMeta {
    return { ...this.meta };
  }

  status(settings: WorkspaceSettings): WorkspaceStatus {
    return workspaceStatus('active', this.meta, settings);
  }

  /** Bytes de todo el workspace (sin seguir enlaces ni contar los metadatos). */
  sizeBytes(): number {
    const files = new Map<string, Stamp>();
    walkFiles(this.dir, '', files, { n: MAX_WALK_ENTRIES * 4 });
    files.delete(WORKSPACE_META_FILE);
    let total = 0;
    for (const f of files.values()) total += f.size;
    return total;
  }

  /** Marca uso (cada turno y cada subida) y recalcula el tamaño. */
  touch(): void {
    this.meta = { ...this.meta, lastUsedAt: this.now().toISOString() };
    this.refresh();
  }

  /** Recalcula el tamaño sin marcar uso. */
  refresh(): void {
    this.meta = { ...this.meta, sizeBytes: this.sizeBytes() };
    this.save();
  }

  /** Fija (excluye de la retención) o desfija. No cuenta como uso. */
  setPinned(pinned: boolean): void {
    this.meta = { ...this.meta, pinned };
    this.save();
  }

  /** Best-effort: un fallo de disco se registra, no tumba la conversación. */
  private save(): void {
    try {
      writeJsonAtomic(this.metaPath, this.meta);
    } catch (err) {
      log.error('workspace metadata save failed', { conversationId: this.conversationId, err });
    }
  }

  snapshotOutputs(): OutputsSnapshot {
    const files = new Map<string, Stamp>();
    walkFiles(join(this.dir, WORKSPACE_DIRS.outputs), '', files, { n: MAX_WALK_ENTRIES });
    return files;
  }

  /** Ficheros de `outputs/` nuevos o modificados desde `before`, del más reciente al más antiguo. */
  changedOutputs(before: OutputsSnapshot): WorkspaceFileInfo[] {
    const changed: WorkspaceFileInfo[] = [];
    for (const [rel, stamp] of this.snapshotOutputs()) {
      const prev = before.get(rel);
      if (prev && prev.size === stamp.size && prev.mtimeMs === stamp.mtimeMs) continue;
      const name = rel.split('/').pop() ?? rel;
      changed.push({
        path: `${WORKSPACE_DIRS.outputs}/${rel}`,
        name,
        size: stamp.size,
        mime: mimeFor(name),
        modifiedAt: new Date(stamp.mtimeMs).toISOString(),
      });
    }
    changed.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
    return changed.slice(0, MAX_REPORTED_OUTPUTS);
  }

  /**
   * Comprueba un adjunto que menciona un `chat`: tiene que ser un fichero
   * regular dentro de `inputs/`. El webview solo nombra rutas del workspace,
   * pero es el webview: no se le cree.
   */
  checkAttachment(rel: string): AttachmentCheck {
    const prefix = `${WORKSPACE_DIRS.inputs}/`;
    if (!rel.startsWith(prefix)) return { ok: false, reason: 'no está en inputs/' };
    const confined = confinePath(this.confinement, rel, 'read');
    if (!confined.ok) return { ok: false, reason: confined.reason };
    if (!confined.relative.startsWith(prefix)) return { ok: false, reason: 'no está en inputs/' };
    try {
      const st = lstatSync(confined.absolute);
      if (!st.isFile()) return { ok: false, reason: 'no es un fichero' };
      return { ok: true, path: confined.relative, size: st.size, mime: mimeFor(rel) };
    } catch {
      return { ok: false, reason: 'no existe' };
    }
  }
}

/**
 * Lee `.workspace.json` de una carpeta. `undefined` si no existe, `null` si
 * existe pero no vale (de otra conversación o mal formado).
 */
function readWorkspaceMeta(dir: string, conversationId: string): WorkspaceMeta | null | undefined {
  const path = join(dir, WORKSPACE_META_FILE);
  if (!existsSync(path)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as Partial<WorkspaceMeta>;
    if (raw.conversationId !== conversationId || !isIso(raw.createdAt)) return null;
    return {
      version: WORKSPACE_META_VERSION,
      conversationId,
      createdAt: raw.createdAt,
      // Un workspace de D2 siempre tuvo `lastUsedAt`; si faltase, se data por su creación.
      lastUsedAt: isIso(raw.lastUsedAt) ? raw.lastUsedAt : raw.createdAt,
      state: 'active',
      sizeBytes: typeof raw.sizeBytes === 'number' ? raw.sizeBytes : 0,
      pinned: raw.pinned === true,
      ...(isIso(raw.filesExpiredAt) ? { filesExpiredAt: raw.filesExpiredAt } : {}),
    };
  } catch {
    return null;
  }
}

/** Qué hay en disco para una conversación. */
export type WorkspaceInspection =
  | { state: 'none' }
  /** `meta: null` → carpeta sin metadatos válidos: la retención no la toca. */
  | { state: 'active'; meta: WorkspaceMeta | null }
  | { state: 'archived'; record: RetentionRecord }
  | { state: 'purged'; record: RetentionRecord };

const TEMP_ENTRY = /^\.(tmp|restoring|trash)-([0-9a-f-]{36})/i;
const ROOT_ENTRY = /^([0-9a-f-]{36})(\.tar\.gz|\.json)?$/i;

/** Crea y resuelve los workspaces de las conversaciones, y ejecuta su retención (D3). */
export class WorkspaceManager {
  /** Cola por conversación: archivar, restaurar y abrir nunca se solapan (16.5). */
  private readonly locks = new Map<string, Promise<unknown>>();
  /** Conversaciones abiertas en el host (contador: abrir y cerrar pueden solaparse). */
  private readonly inUse = new Map<string, number>();

  private current: WorkspaceSettings;

  constructor(
    settings: WorkspaceSettings,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.current = settings;
  }

  get settings(): WorkspaceSettings {
    return this.current;
  }

  get root(): string {
    return this.settings.root;
  }

  /**
   * Plazos de retención nuevos desde Ajustes (D5): cuentan desde el siguiente
   * pase y en la fecha de purga que ve la UI. La raíz y los límites de subida
   * no cambian en caliente (Rust los recibe en el handshake): esos esperan a
   * reiniciar el agente.
   */
  updateRetention(s: Pick<WorkspaceSettings, 'compressAfterMs' | 'deleteAfterMs'>): void {
    this.current = {
      ...this.current,
      compressAfterMs: s.compressAfterMs,
      deleteAfterMs: s.deleteAfterMs,
    };
  }

  /** Uso de disco de la raíz, por estado (Ajustes → Espacios de trabajo). */
  usage(): {
    totalBytes: number;
    active: { count: number; bytes: number };
    archived: { count: number; bytes: number };
    purged: { count: number };
  } {
    const out = {
      totalBytes: 0,
      active: { count: 0, bytes: 0 },
      archived: { count: 0, bytes: 0 },
      purged: { count: 0 },
    };
    for (const id of this.list()) {
      let found: WorkspaceInspection;
      try {
        found = this.inspect(id);
      } catch {
        continue;
      }
      if (found.state === 'active') {
        const files = new Map<string, Stamp>();
        walkFiles(this.checkedDir(id), '', files, { n: MAX_WALK_ENTRIES * 4 });
        let bytes = 0;
        for (const f of files.values()) bytes += f.size;
        out.active.count++;
        out.active.bytes += bytes;
      } else if (found.state === 'archived') {
        let bytes = 0;
        try {
          bytes = statSync(this.archivePath(id)).size;
        } catch {
          /* desapareció entre medias */
        }
        out.archived.count++;
        out.archived.bytes += bytes;
      } else if (found.state === 'purged') {
        out.purged.count++;
      }
    }
    out.totalBytes = out.active.bytes + out.archived.bytes;
    return out;
  }

  private checkedDir(conversationId: string): string {
    if (!isConversationId(conversationId)) {
      throw new Error(`conversationId inválido: ${JSON.stringify(conversationId.slice(0, 64))}`);
    }
    const dir = resolve(this.settings.root, conversationId);
    if (!dir.startsWith(resolve(this.settings.root) + sep)) {
      throw new Error('ruta de workspace fuera de la raíz');
    }
    return dir;
  }

  archivePath(conversationId: string): string {
    return `${this.checkedDir(conversationId)}.tar.gz`;
  }

  recordPath(conversationId: string): string {
    return `${this.checkedDir(conversationId)}.json`;
  }

  /**
   * Workspace de `conversationId`, creado si no existe. Síncrono y sin lock:
   * no restaura un archivado (el host usa `acquire`). Lanza con un id que no es UUID.
   */
  open(
    conversationId: string,
    initial?: Partial<Pick<WorkspaceMeta, 'filesExpiredAt' | 'pinned'>>,
  ): ConversationWorkspace {
    const dir = this.checkedDir(conversationId);
    mkdirSync(dir, { recursive: true });
    return new ConversationWorkspace(conversationId, dir, this.now, initial);
  }

  /** Ejecuta `fn` con el lock de la conversación (FIFO). */
  withLock<T>(conversationId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(conversationId) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => undefined);
    this.locks.set(conversationId, tail);
    void tail.then(() => {
      if (this.locks.get(conversationId) === tail) this.locks.delete(conversationId);
    });
    return run;
  }

  isInUse(conversationId: string): boolean {
    return (this.inUse.get(conversationId) ?? 0) > 0;
  }

  /**
   * Workspace de una conversación que se abre en el host. La marca en uso (la
   * retención deja de tocarla) y, con el lock, espera a una compresión en
   * marcha, restaura un `archived` o da un workspace nuevo a uno `purged`. Si
   * no lanza, el llamador tiene que llamar a `release` al cerrar.
   */
  async acquire(
    conversationId: string,
    hooks: { onRestoring?: () => void } = {},
  ): Promise<{ workspace: ConversationWorkspace; restored: boolean }> {
    this.checkedDir(conversationId);
    this.inUse.set(conversationId, (this.inUse.get(conversationId) ?? 0) + 1);
    try {
      return await this.withLock(conversationId, async () => {
        const found = this.inspect(conversationId);
        if (found.state === 'archived') {
          hooks.onRestoring?.();
          await this.restore(conversationId, found.record);
          return { workspace: this.open(conversationId), restored: true };
        }
        if (found.state === 'purged') {
          // Workspace nuevo y vacío; la fecha de la purga avisa al agente y a la UI.
          const workspace = this.open(conversationId, {
            filesExpiredAt: found.record.purgedAt ?? this.now().toISOString(),
          });
          rmSync(this.recordPath(conversationId), { force: true });
          return { workspace, restored: false };
        }
        return { workspace: this.open(conversationId), restored: false };
      });
    } catch (err) {
      this.release(conversationId);
      throw err;
    }
  }

  release(conversationId: string): void {
    const n = (this.inUse.get(conversationId) ?? 0) - 1;
    if (n > 0) this.inUse.set(conversationId, n);
    else this.inUse.delete(conversationId);
  }

  /** Lectura pura del estado en disco (sin limpiar nada: eso es `recover`). */
  inspect(conversationId: string): WorkspaceInspection {
    const dir = this.checkedDir(conversationId);
    let hasDir = false;
    try {
      hasDir = lstatSync(dir).isDirectory();
    } catch {
      /* no existe */
    }
    const archive = this.archivePath(conversationId);
    const hasArchive = existsSync(archive);
    if (hasDir) {
      const meta = readWorkspaceMeta(dir, conversationId) ?? null;
      // La carpeta gana solo si es un workspace de verdad: una carpeta sin
      // metadatos junto a un archivo no la creó el sidecar (el archivo manda).
      if (meta || !hasArchive) return { state: 'active', meta };
    }
    const record = this.readRecord(conversationId);
    if (record?.state === 'purged' && !hasDir) return { state: 'purged', record };
    if (hasArchive) {
      if (record?.state === 'archived') return { state: 'archived', record };
      // Registro perdido: se data por el propio archivo.
      const iso = statSync(archive).mtime.toISOString();
      return {
        state: 'archived',
        record: {
          version: 1,
          conversationId,
          state: 'archived',
          createdAt: iso,
          lastUsedAt: iso,
          pinned: false,
          sizeBytes: 0,
          archivedAt: iso,
        },
      };
    }
    return { state: 'none' };
  }

  /** Estado para la UI de una conversación, abierta o no; `null` si no tiene workspace. */
  statusOf(conversationId: string): WorkspaceStatus | null {
    const found = this.inspect(conversationId);
    if (found.state === 'none') return null;
    if (found.state === 'active') {
      return found.meta ? workspaceStatus('active', found.meta, this.settings) : null;
    }
    return workspaceStatus(found.state, found.record, this.settings);
  }

  private readRecord(conversationId: string): RetentionRecord | null {
    const path = this.recordPath(conversationId);
    if (!existsSync(path)) return null;
    try {
      const raw = JSON.parse(readFileSync(path, 'utf-8')) as Partial<RetentionRecord>;
      if (
        raw.conversationId !== conversationId ||
        (raw.state !== 'archived' && raw.state !== 'purged') ||
        !isIso(raw.lastUsedAt)
      ) {
        return null;
      }
      return {
        version: 1,
        conversationId,
        state: raw.state,
        createdAt: isIso(raw.createdAt) ? raw.createdAt : raw.lastUsedAt,
        lastUsedAt: raw.lastUsedAt,
        pinned: raw.pinned === true,
        sizeBytes: typeof raw.sizeBytes === 'number' ? raw.sizeBytes : 0,
        ...(isIso(raw.filesExpiredAt) ? { filesExpiredAt: raw.filesExpiredAt } : {}),
        ...(isIso(raw.archivedAt) ? { archivedAt: raw.archivedAt } : {}),
        ...(typeof raw.archiveBytes === 'number' ? { archiveBytes: raw.archiveBytes } : {}),
        ...(isIso(raw.purgedAt) ? { purgedAt: raw.purgedAt } : {}),
      };
    } catch (err) {
      log.warn('retention record unreadable', { conversationId, err });
      return null;
    }
  }

  /** Conversaciones con algo en la raíz (carpeta, archivo o registro). */
  list(): string[] {
    let entries: string[];
    try {
      entries = readdirSync(this.settings.root);
    } catch {
      return [];
    }
    const ids = new Set<string>();
    for (const e of entries) {
      const m = ROOT_ENTRY.exec(e);
      if (m && isConversationId(m[1])) ids.add(m[1]);
    }
    return [...ids].sort();
  }

  /**
   * Deja la raíz limpia tras un apagado brusco: borra los temporales y lo que
   * sobra según la regla «la carpeta gana; `purged` es terminal». No toca las
   * conversaciones en uso. Best-effort.
   */
  async recover(): Promise<void> {
    let entries: string[] = [];
    try {
      entries = readdirSync(this.settings.root);
    } catch {
      return;
    }
    for (const e of entries) {
      const m = TEMP_ENTRY.exec(e);
      if (!m || this.isInUse(m[2])) continue;
      await this.withLock(m[2], () =>
        rm(join(this.settings.root, e), { recursive: true, force: true }),
      ).catch((err) => log.warn('temp cleanup failed', { entry: e, err }));
    }
    for (const id of this.list()) {
      if (this.isInUse(id)) continue;
      await this.withLock(id, async () => {
        const found = this.inspect(id);
        if (found.state === 'active') {
          // Compresión que no llegó a retirar la carpeta, o restauración que
          // no llegó a borrar el archivo: en los dos casos la carpeta está entera.
          rmSync(this.archivePath(id), { force: true });
          rmSync(this.recordPath(id), { force: true });
        } else if (found.state === 'purged') {
          rmSync(this.archivePath(id), { force: true });
        }
      }).catch((err) => log.warn('retention recovery failed', { conversationId: id, err }));
    }
  }

  /**
   * `active → archived`. Requiere el lock. Comprime a un temporal, lo verifica
   * contra la carpeta, lo publica, escribe el registro y solo entonces retira
   * la carpeta. Si algo falla antes de retirarla, la carpeta sigue y el
   * archivo se descarta.
   */
  async archive(conversationId: string): Promise<void> {
    const dir = this.checkedDir(conversationId);
    const meta = readWorkspaceMeta(dir, conversationId);
    if (!meta) throw new Error('el workspace no tiene metadatos válidos');
    const tmp = join(this.settings.root, `.tmp-${conversationId}.tar.gz`);
    const archive = this.archivePath(conversationId);
    const record = this.recordPath(conversationId);
    try {
      const manifest = await packDirectory(dir, tmp);
      await verifyArchive(tmp, manifest);
      renameSync(tmp, archive);
    } catch (err) {
      rmSync(tmp, { force: true });
      throw err;
    }
    try {
      writeJsonAtomic(record, {
        version: 1,
        conversationId,
        state: 'archived',
        createdAt: meta.createdAt,
        lastUsedAt: meta.lastUsedAt,
        pinned: meta.pinned,
        sizeBytes: meta.sizeBytes,
        ...(meta.filesExpiredAt ? { filesExpiredAt: meta.filesExpiredAt } : {}),
        archivedAt: this.now().toISOString(),
        archiveBytes: statSync(archive).size,
      } satisfies RetentionRecord);
      this.retireDir(conversationId, dir);
    } catch (err) {
      // La carpeta sigue: se deshace lo publicado para no dejar dos verdades.
      rmSync(archive, { force: true });
      rmSync(record, { force: true });
      throw err;
    }
  }

  /** `archived → active`. Requiere el lock. Extrae a un temporal y lo publica con un rename. */
  async restore(conversationId: string, record: RetentionRecord): Promise<void> {
    const dir = this.checkedDir(conversationId);
    const staging = join(this.settings.root, `.restoring-${conversationId}`);
    await rm(staging, { recursive: true, force: true });
    if (existsSync(dir)) {
      // Carpeta sin metadatos junto al archivo (ver `inspect`): se aparta, no
      // se borra, por si alguien dejó algo ahí.
      const orphan = join(this.settings.root, `.orphan-${conversationId}-${Date.now()}`);
      log.warn('stray folder next to an archive; moved aside', { conversationId, orphan });
      renameSync(dir, orphan);
    }
    await extractArchive(this.archivePath(conversationId), staging);
    const restored: WorkspaceMeta = {
      version: WORKSPACE_META_VERSION,
      conversationId,
      createdAt: record.createdAt,
      // Restaurar no es usar: el reloj de la retención sigue donde estaba.
      lastUsedAt: record.lastUsedAt,
      state: 'active',
      sizeBytes: record.sizeBytes,
      pinned: record.pinned,
      ...(record.filesExpiredAt ? { filesExpiredAt: record.filesExpiredAt } : {}),
    };
    try {
      writeJsonAtomic(join(staging, WORKSPACE_META_FILE), restored);
      renameSync(staging, dir);
    } catch (err) {
      await rm(staging, { recursive: true, force: true });
      throw err;
    }
    rmSync(this.archivePath(conversationId), { force: true });
    rmSync(this.recordPath(conversationId), { force: true });
  }

  /**
   * `active|archived → purged`. Requiere el lock. El registro `purged` se
   * escribe primero: a partir de ahí la purga es firme aunque el borrado se
   * interrumpa (lo termina `recover`).
   */
  async purge(conversationId: string): Promise<void> {
    const found = this.inspect(conversationId);
    if (found.state === 'none' || found.state === 'purged') return;
    const base = found.state === 'active' ? found.meta : found.record;
    if (!base) throw new Error('el workspace no tiene metadatos válidos');
    const iso = this.now().toISOString();
    const recordPath = this.recordPath(conversationId);
    writeJsonAtomic(recordPath, {
      version: 1,
      conversationId,
      state: 'purged',
      createdAt: base.createdAt,
      lastUsedAt: base.lastUsedAt,
      pinned: base.pinned,
      sizeBytes: base.sizeBytes,
      filesExpiredAt: iso,
      purgedAt: iso,
    } satisfies RetentionRecord);
    if (found.state === 'archived') {
      await rm(this.archivePath(conversationId), { force: true });
      return;
    }
    try {
      this.retireDir(conversationId, this.checkedDir(conversationId));
    } catch (err) {
      rmSync(recordPath, { force: true });
      throw err;
    }
  }

  /**
   * Fija o desfija una conversación que no está abierta en el host (desde el
   * sidebar, D4): en los metadatos de la carpeta o en el registro del archivo.
   * Sin workspace o purgada no hay nada que proteger. Devuelve el estado nuevo.
   */
  async setPinned(conversationId: string, pinned: boolean): Promise<WorkspaceStatus | null> {
    const dir = this.checkedDir(conversationId);
    return this.withLock(conversationId, async () => {
      const found = this.inspect(conversationId);
      if (found.state === 'active' && found.meta) {
        writeJsonAtomic(join(dir, WORKSPACE_META_FILE), { ...found.meta, pinned });
      } else if (found.state === 'archived') {
        writeJsonAtomic(this.recordPath(conversationId), { ...found.record, pinned });
      }
      return this.statusOf(conversationId);
    });
  }

  /**
   * Elimina todo lo de la conversación (D4): carpeta, archivo y registro. Con
   * el lock, así no se cruza con una compresión o una restauración. El llamador
   * garantiza que la conversación ya no está abierta en el host.
   */
  async remove(conversationId: string): Promise<void> {
    const dir = this.checkedDir(conversationId);
    await this.withLock(conversationId, async () => {
      if (existsSync(dir)) this.retireDir(conversationId, dir);
      await rm(this.archivePath(conversationId), { force: true });
      await rm(this.recordPath(conversationId), { force: true });
    });
  }

  /**
   * Retira la carpeta con un rename atómico a `.trash-*` y la borra en
   * segundo plano. Si el rename falla (un fichero abierto en Windows), lanza
   * con la carpeta intacta; si falla el borrado, lo termina `recover`.
   */
  private retireDir(conversationId: string, dir: string): void {
    const trash = join(this.settings.root, `.trash-${conversationId}-${Date.now()}`);
    renameSync(dir, trash);
    void rm(trash, { recursive: true, force: true }).catch((err) =>
      log.warn('trash cleanup failed', { conversationId, err }),
    );
  }
}
