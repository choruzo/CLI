import { createHash } from 'crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, watch, type FSWatcher } from 'fs';
import { basename, dirname, resolve } from 'path';
import { homedir } from 'os';
import { StratumConfigSchema } from '../config/schema.js';
import { expandEnvVars, findConfigFile, GLOBAL_CONFIG_PATH } from '../config/loader.js';
import { CONFIG_SCHEMA_VERSION, checkSchemaVersion } from '../config/schema-version.js';
import { writeFileAtomic } from '../config/writer.js';
import { getLogger } from '../logging/index.js';
import { SECRET_PLACEHOLDER, type ConfigIssue, type ConfigSnapshot } from './protocol.js';

const log = getLogger('desktop.config');

/** Debounce del watcher: un editor escribe en varias pasadas (15.7). */
export const CONFIG_WATCH_DEBOUNCE_MS = 300;

type Path = Array<string | number>;
type Json = Record<string, unknown>;

/**
 * El `.stratumrc.json` global visto desde el panel de Ajustes de Stratum
 * Desktop (D5, 15.7). Es la misma config que usa la CLI; Desktop edita **solo**
 * la global (`~/.stratum/.stratumrc.json`), que es la que la CLI lee desde
 * cualquier carpeta.
 *
 * - **Secretos enmascarados.** Un secreto literal (API key, password…) llega al
 *   webview como `SECRET_PLACEHOLDER`; al guardar, un campo que lo conserva
 *   recupera el valor de disco. Un `${VAR}` o un `env:VAR` no es un secreto, es
 *   una referencia, y se ve tal cual.
 * - **Un secreto no viaja a otra URL.** Si el borrador cambia el origen de la
 *   `baseUrl`/`url` junto a un secreto enmascarado, no se restaura: hay que
 *   volver a escribirlo. Si no, cambiar la URL de un provider bastaría para
 *   enviar su key guardada a otro servidor.
 * - **Concurrencia optimista por contenido.** El webview guarda sobre el sha256
 *   que leyó; si el fichero cambió en disco entretanto (la CLI, otro editor), no
 *   se pisa. Por hash y no por mtime: la resolución del mtime depende del
 *   sistema de ficheros, y un `touch` sin cambios no es un conflicto.
 * - **Watcher sin bucle.** Un evento del directorio solo cuenta si el hash del
 *   fichero difiere del último conocido, que incluye lo que escribió el propio
 *   panel: una escritura propia nunca vuelve como cambio externo (es la marca
 *   `_selfWrite` de §4, sin ventana temporal que pueda fallar).
 */
export class ConfigPanel {
  /** Hash del contenido que el panel leyó o escribió por última vez. */
  private knownHash: string | null | undefined;
  private watcher: FSWatcher | null = null;
  private debounce: NodeJS.Timeout | null = null;

  constructor(
    readonly path: string = GLOBAL_CONFIG_PATH,
    private readonly home: string = homedir(),
  ) {}

  // -------------------------------------------------------------------------
  // Lectura
  // -------------------------------------------------------------------------

  private readDisk(): { exists: boolean; content: string; hash: string | null } {
    if (!existsSync(this.path)) return { exists: false, content: '', hash: null };
    const content = readFileSync(this.path, 'utf-8');
    return { exists: true, content, hash: sha256(content) };
  }

  /** El JSON de disco como objeto, o `{}` si no existe o no se puede leer. */
  private diskObject(): Json {
    try {
      const { content, exists } = this.readDisk();
      if (!exists) return {};
      const value = JSON.parse(content) as unknown;
      return isObject(value) ? value : {};
    } catch {
      return {};
    }
  }

  snapshot(): ConfigSnapshot {
    const disk = this.readDisk();
    this.knownHash = disk.hash;
    const base = {
      path: this.path,
      exists: disk.exists,
      hash: disk.hash,
      overrides: this.overrides(),
    };
    if (!disk.exists) return { ...base, text: '', parseError: null, readOnly: null };
    let value: unknown;
    try {
      value = JSON.parse(disk.content);
    } catch (err) {
      // Sin interpretar no se sabe qué es secreto: el contenido va tal cual
      // (es lo que hay en el disco del usuario) para poder arreglarlo.
      return { ...base, text: disk.content, parseError: jsonErrorMessage(err), readOnly: null };
    }
    if (!isObject(value)) {
      return {
        ...base,
        text: disk.content,
        parseError: 'La config tiene que ser un objeto JSON.',
        readOnly: null,
      };
    }
    return {
      ...base,
      text: JSON.stringify(maskSecrets(value), null, 2),
      parseError: null,
      readOnly: newerSchemaMessage(value.schemaVersion),
    };
  }

  /** Capas que se fusionan por encima de la global al cargar desde el home. */
  private overrides(): string[] {
    const found = findConfigFile(this.home);
    return found && !samePath(found, this.path) ? [found] : [];
  }

  /**
   * Provider tal como está guardado (con los `${VAR}` expandidos), para que el
   * wizard sondee `/models` con su key sin que la key pase por el webview.
   */
  storedProvider(name: string): { baseUrl: string; apiKey: string } | null {
    const providers = getAt(this.diskObject(), ['provider', 'providers']);
    const entry = isObject(providers) ? providers[name] : undefined;
    if (!isObject(entry) || typeof entry.baseUrl !== 'string') return null;
    return {
      baseUrl: String(expandEnvVars(entry.baseUrl)),
      apiKey: typeof entry.apiKey === 'string' ? String(expandEnvVars(entry.apiKey)) : '',
    };
  }

  // -------------------------------------------------------------------------
  // Validación y guardado
  // -------------------------------------------------------------------------

  /**
   * Valida un borrador como lo haría el loader: secretos restaurados, `${VAR}`
   * expandidas y el schema Zod. No escribe nada.
   */
  validate(text: string): { issues: ConfigIssue[]; value: Json | null } {
    const parsed = parseDraft(text);
    if (!parsed.ok) return { issues: parsed.issues, value: null };
    const issues: ConfigIssue[] = [];
    const value = restoreSecrets(parsed.value, this.diskObject(), issues);
    const version = checkSchemaVersion(value.schemaVersion, CONFIG_SCHEMA_VERSION);
    if (!version.ok) {
      issues.push({
        path: 'schemaVersion',
        message:
          version.reason === 'newer'
            ? `Este Stratum solo entiende hasta la versión ${CONFIG_SCHEMA_VERSION}.`
            : 'Tiene que ser un entero positivo.',
      });
    }
    const result = StratumConfigSchema.safeParse(expandEnvVars(value));
    if (!result.success) {
      for (const issue of result.error.issues) {
        issues.push({ path: issue.path.join('.'), message: issue.message });
      }
    }
    return { issues, value: issues.length === 0 ? value : null };
  }

  save(
    text: string,
    baseHash: string | null,
    force = false,
  ):
    | { kind: 'saved'; hash: string }
    | { kind: 'conflict' }
    | { kind: 'invalid'; issues: ConfigIssue[] }
    | { kind: 'read_only'; message: string } {
    const current = this.readDisk();
    if (!force && current.hash !== baseHash) return { kind: 'conflict' };
    const readOnly = newerSchemaMessage(this.diskObject().schemaVersion);
    if (readOnly) return { kind: 'read_only', message: readOnly };
    const { issues, value } = this.validate(text);
    if (!value) return { kind: 'invalid', issues };

    const content = JSON.stringify(value, null, 2) + '\n';
    // Mismo respaldo que el wizard de la CLI (`writeConfigWithBackup`).
    if (current.exists) copyFileSync(this.path, `${this.path}.bak`);
    writeFileAtomic(this.path, content);
    const hash = sha256(content);
    this.knownHash = hash;
    return { kind: 'saved', hash };
  }

  // -------------------------------------------------------------------------
  // Watcher
  // -------------------------------------------------------------------------

  /**
   * Vigila el directorio (no el fichero: una escritura atómica lo sustituye por
   * otro y el watch de un fichero se queda mirando el viejo). `onChange` solo
   * se llama si el contenido difiere del último conocido.
   */
  watch(onChange: () => void, debounceMs = CONFIG_WATCH_DEBOUNCE_MS): () => void {
    if (this.knownHash === undefined) this.knownHash = this.readDisk().hash;
    const dir = dirname(this.path);
    const name = basename(this.path);
    try {
      mkdirSync(dir, { recursive: true });
      this.watcher = watch(dir, (_event, filename) => {
        // Algunas plataformas no dan el nombre: se comprueba por si acaso.
        if (filename && filename.toString() !== name) return;
        if (this.debounce) clearTimeout(this.debounce);
        this.debounce = setTimeout(() => {
          this.debounce = null;
          this.checkExternal(onChange);
        }, debounceMs);
        this.debounce.unref();
      });
      this.watcher.on('error', (err) => log.warn('config watcher error', { err }));
    } catch (err) {
      // Sin watcher Ajustes sigue funcionando: el conflicto se detecta al guardar.
      log.warn('config watcher unavailable', { dir, err });
    }
    return () => this.unwatch();
  }

  private checkExternal(onChange: () => void): void {
    let hash: string | null;
    try {
      hash = this.readDisk().hash;
    } catch (err) {
      log.warn('config unreadable after change', { err });
      return;
    }
    if (hash === this.knownHash) return;
    this.knownHash = hash;
    onChange();
  }

  unwatch(): void {
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = null;
    this.watcher?.close();
    this.watcher = null;
  }
}

// ---------------------------------------------------------------------------
// Secretos
// ---------------------------------------------------------------------------

const SECRET_KEYS = /^(apiKey|tavilyApiKey|password|passphrase|token|secret|clientSecret)$/i;

/** ¿La clave en `path` guarda un secreto? También los `env` de los servers MCP. */
export function isSecretPath(path: Path): boolean {
  const key = path[path.length - 1];
  if (typeof key === 'string' && SECRET_KEYS.test(key)) return true;
  return path.length === 5 && path[0] === 'mcp' && path[1] === 'servers' && path[3] === 'env';
}

/** `${VAR}` o `env:VAR`: una referencia, no un secreto. */
function isReference(value: string): boolean {
  return value.includes('${') || value.startsWith('env:');
}

export function maskSecrets(value: unknown, path: Path = []): unknown {
  if (typeof value === 'string') {
    return isSecretPath(path) && value !== '' && !isReference(value) ? SECRET_PLACEHOLDER : value;
  }
  if (Array.isArray(value)) return value.map((v, i) => maskSecrets(v, [...path, i]));
  if (isObject(value)) {
    const out: Json = {};
    for (const [k, v] of Object.entries(value)) out[k] = maskSecrets(v, [...path, k]);
    return out;
  }
  return value;
}

/**
 * Sustituye cada `SECRET_PLACEHOLDER` del borrador por el valor de disco en la
 * misma ruta. Un marcador sin secreto guardado detrás, o junto a una URL cuyo
 * origen cambió, se queda como problema: no se escribe el marcador literal.
 */
export function restoreSecrets(draft: Json, disk: Json, issues: ConfigIssue[]): Json {
  const walk = (value: unknown, path: Path, parent: Json | null): unknown => {
    if (value === SECRET_PLACEHOLDER) {
      const stored = getAt(disk, path);
      const where = path.join('.');
      if (!isSecretPath(path) || typeof stored !== 'string' || stored === SECRET_PLACEHOLDER) {
        issues.push({
          path: where,
          message: 'No hay ningún secreto guardado en esta clave: escribe el valor.',
        });
        return value;
      }
      const storedParent = getAt(disk, path.slice(0, -1));
      if (parent && isObject(storedParent) && urlOriginChanged(parent, storedParent)) {
        issues.push({
          path: where,
          message: 'La URL cambió de servidor: vuelve a escribir el secreto para la nueva.',
        });
        return value;
      }
      return stored;
    }
    if (Array.isArray(value)) return value.map((v, i) => walk(v, [...path, i], null));
    if (isObject(value)) {
      const out: Json = {};
      for (const [k, v] of Object.entries(value)) out[k] = walk(v, [...path, k], value);
      return out;
    }
    return value;
  };
  return walk(draft, [], null) as Json;
}

function urlOriginChanged(draft: Json, stored: Json): boolean {
  for (const key of ['baseUrl', 'url']) {
    const a = draft[key];
    const b = stored[key];
    if (typeof a === 'string' && typeof b === 'string' && !sameOrigin(a, b)) return true;
  }
  return false;
}

/** Mismo origen (esquema + host + puerto) tras expandir `${VAR}`. */
export function sameOrigin(a: string, b: string): boolean {
  return originOf(a) === originOf(b);
}

function originOf(url: string): string {
  const expanded = String(expandEnvVars(url)).trim();
  try {
    return new URL(expanded).origin;
  } catch {
    return expanded;
  }
}

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

function parseDraft(
  text: string,
): { ok: true; value: Json } | { ok: false; issues: ConfigIssue[] } {
  if (text.trim() === '') return { ok: true, value: {} };
  try {
    const value = JSON.parse(text) as unknown;
    if (!isObject(value)) {
      return {
        ok: false,
        issues: [{ path: '', message: 'La config tiene que ser un objeto JSON.' }],
      };
    }
    return { ok: true, value };
  } catch (err) {
    const message = jsonErrorMessage(err);
    const at = jsonErrorPosition(err, text);
    return { ok: false, issues: [{ path: '', message, ...at }] };
  }
}

function jsonErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return `JSON no válido: ${raw}`;
}

/** Línea y columna de un `SyntaxError` de `JSON.parse` (V8 da la posición o la línea). */
export function jsonErrorPosition(err: unknown, text: string): { line?: number; column?: number } {
  const message = err instanceof Error ? err.message : '';
  const lc = /line (\d+) column (\d+)/.exec(message);
  if (lc) return { line: Number(lc[1]), column: Number(lc[2]) };
  const pos = /position (\d+)/.exec(message);
  if (pos) {
    const before = text.slice(0, Number(pos[1]));
    const lines = before.split('\n');
    return { line: lines.length, column: lines[lines.length - 1].length + 1 };
  }
  if (/end of JSON input/i.test(message)) {
    const lines = text.split('\n');
    return { line: lines.length, column: lines[lines.length - 1].length + 1 };
  }
  return {};
}

function newerSchemaMessage(version: unknown): string | null {
  const check = checkSchemaVersion(version, CONFIG_SCHEMA_VERSION);
  if (check.ok || check.reason !== 'newer') return null;
  return (
    `La config usa schemaVersion ${String(version)} y este Stratum solo entiende hasta la ` +
    `${CONFIG_SCHEMA_VERSION}: la escribió una versión más nueva. Actualiza Stratum Desktop ` +
    'para editarla sin perder datos.'
  );
}

function getAt(value: unknown, path: Path): unknown {
  let current = value;
  for (const key of path) {
    if (Array.isArray(current) && typeof key === 'number') current = current[key];
    else if (isObject(current) && typeof key === 'string') current = current[key];
    else return undefined;
  }
  return current;
}

function isObject(value: unknown): value is Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string) =>
    process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p);
  return norm(a) === norm(b);
}
