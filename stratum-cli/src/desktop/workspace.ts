import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'fs';
import { homedir } from 'os';
import { extname, isAbsolute, join, parse, resolve, sep } from 'path';
import type { StratumConfig } from '../config/schema.js';
import type { WorkspaceConfinement } from '../agent/types.js';
import { confinePath } from '../tools/fs/confine.js';
import { getLogger } from '../logging/index.js';
import { isConversationId } from './session-store.js';
import type { WorkspaceFileInfo } from './protocol.js';

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
  lastUsedAt: string;
  /** D3 añade `archived` y `purged`. */
  state: 'active';
  sizeBytes: number;
  pinned: boolean;
}

export interface WorkspaceSettings {
  root: string;
  maxFileBytes: number;
  maxWorkspaceBytes: number;
}

const MB = 1024 * 1024;

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

/** El workspace de una conversación, ya creado en disco. */
export class ConversationWorkspace {
  readonly confinement: WorkspaceConfinement;
  private meta: WorkspaceMeta;

  constructor(
    readonly conversationId: string,
    readonly dir: string,
    private readonly now: () => Date,
  ) {
    this.confinement = {
      root: dir,
      readOnly: [WORKSPACE_DIRS.inputs],
      writable: [WORKSPACE_DIRS.outputs, WORKSPACE_DIRS.scratch],
    };
    for (const sub of Object.values(WORKSPACE_DIRS)) mkdirSync(join(dir, sub), { recursive: true });
    this.meta = this.loadMeta() ?? this.freshMeta();
    this.touch();
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
    if (!existsSync(this.metaPath)) return null;
    try {
      const raw = JSON.parse(readFileSync(this.metaPath, 'utf-8')) as Partial<WorkspaceMeta>;
      if (raw.conversationId !== this.conversationId || typeof raw.createdAt !== 'string') {
        return null;
      }
      return {
        ...this.freshMeta(),
        createdAt: raw.createdAt,
        pinned: raw.pinned === true,
      };
    } catch (err) {
      log.warn('workspace metadata unreadable; regenerating', {
        conversationId: this.conversationId,
        err,
      });
      return null;
    }
  }

  getMeta(): WorkspaceMeta {
    return { ...this.meta };
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

  /**
   * Marca uso (cada turno y cada subida) y recalcula el tamaño. Best-effort:
   * un fallo de disco se registra, no tumba la conversación.
   */
  touch(): void {
    this.meta = {
      ...this.meta,
      lastUsedAt: this.now().toISOString(),
      sizeBytes: this.sizeBytes(),
    };
    try {
      const tmp = `${this.metaPath}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.meta, null, 2), 'utf-8');
      renameSync(tmp, this.metaPath);
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

/** Crea y resuelve los workspaces de las conversaciones. */
export class WorkspaceManager {
  constructor(
    readonly settings: WorkspaceSettings,
    private readonly now: () => Date = () => new Date(),
  ) {}

  get root(): string {
    return this.settings.root;
  }

  /** Workspace de `conversationId`, creado si no existe. Lanza con un id que no es UUID. */
  open(conversationId: string): ConversationWorkspace {
    if (!isConversationId(conversationId)) {
      throw new Error(`conversationId inválido: ${JSON.stringify(conversationId.slice(0, 64))}`);
    }
    const dir = resolve(this.settings.root, conversationId);
    if (!dir.startsWith(resolve(this.settings.root) + sep)) {
      throw new Error('ruta de workspace fuera de la raíz');
    }
    mkdirSync(dir, { recursive: true });
    return new ConversationWorkspace(conversationId, dir, this.now);
  }
}
