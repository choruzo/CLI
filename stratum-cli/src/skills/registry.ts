/**
 * Hito 12 — Registro de skills (P2 de `gentle-pi`). Una *skill* son
 * instrucciones de tarea escritas a mano: un markdown con frontmatter
 * (`name`, `description`) que el agente lee cuando su disparador encaja.
 *
 *   ~/.stratum/skills/<nombre>/SKILL.md            (usuario)
 *   ~/.claude/skills/<nombre>/SKILL.md             (usuario, cortesía)
 *   <proyecto>/.stratum/skills/<nombre>/SKILL.md   (proyecto, prioritario)
 *   <proyecto>/.claude/skills/<nombre>/SKILL.md    (proyecto, cortesía)
 *
 * La idea que se adopta de gentle-pi es «índice barato siempre en contexto,
 * cuerpo caro solo cuando hace falta»: en el system prompt va una tabla
 * `nombre → cuándo usarla → ruta`, y el cuerpo se carga con `read_file` bajo
 * demanda. El padre descubre una sola vez por sesión y le pasa el mismo índice
 * a los subagentes: un hijo nunca redescubre nada.
 *
 * Ver CLI-DOC/Investigacion/gentle-pi.md §2 (P2).
 */
import { createHash } from 'crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'fs';
import { homedir } from 'os';
import { dirname, join, relative, resolve, sep } from 'path';
import { splitFrontmatter } from '../agent/frontmatter.js';
import { getLogger } from '../logging/index.js';

const log = getLogger('skills');

/** Versión del formato del índice. Cambiarla invalida el fingerprint cacheado. */
export const SKILL_REGISTRY_SCHEMA = 1;

/** Cabecera del fichero generado: marca de agua + fingerprint para la caché. */
const REGISTRY_HEADER = '<!-- Generado por Stratum. No editar a mano. -->';
const FINGERPRINT_RE = /<!--\s*stratum-skill-registry\s+v(\d+)\s+fingerprint:\s*([0-9a-f]+)\s*-->/;

export type SkillScope = 'project' | 'user';

export interface SkillEntry {
  /** Nombre canónico (frontmatter `name`, o el del directorio/fichero). */
  name: string;
  /** Cuándo usarla (frontmatter `description`). Vacío si el fichero no la declara. */
  description: string;
  /** Ruta absoluta al fichero de la skill. */
  path: string;
  scope: SkillScope;
  /** Etiqueta del directorio de origen, p.ej. `.stratum/skills`. */
  source: string;
}

interface SkillDir {
  dir: string;
  scope: SkillScope;
  source: string;
}

/**
 * Directorios a escanear, de MENOR a MAYOR precedencia: el último que declara
 * un nombre gana. Proyecto sobre usuario, y `.stratum` sobre `.claude` dentro
 * de cada ámbito (lo nuestro manda sobre la cortesía).
 */
export function skillDirs(projectRoots: string[], home: string = homedir()): SkillDir[] {
  const dirs: SkillDir[] = [
    { dir: join(home, '.claude', 'skills'), scope: 'user', source: '.claude/skills' },
    { dir: join(home, '.stratum', 'skills'), scope: 'user', source: '.stratum/skills' },
  ];
  for (const root of projectRoots) {
    dirs.push({ dir: join(root, '.claude', 'skills'), scope: 'project', source: '.claude/skills' });
    dirs.push({
      dir: join(root, '.stratum', 'skills'),
      scope: 'project',
      source: '.stratum/skills',
    });
  }
  const seen = new Set<string>();
  return dirs.filter((d) => {
    const key = resolve(d.dir);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export class SkillRegistry {
  private readonly byName = new Map<string, SkillEntry>();
  /** sha1 del contenido + mtime de cada skill: si no cambia, no se reescribe el índice. */
  private readonly fingerprintValue: string;

  /** `opts.home` existe para los tests: fija el home en vez de leer el del sistema. */
  constructor(projectRoots: string | string[] = process.cwd(), opts?: { home?: string }) {
    const roots = Array.isArray(projectRoots) ? projectRoots : [projectRoots];
    const parts: string[] = [`v${SKILL_REGISTRY_SCHEMA}`];
    for (const { dir, scope, source } of skillDirs(roots, opts?.home)) {
      for (const file of listSkillFiles(dir)) {
        let raw: string;
        let mtimeMs = 0;
        try {
          raw = readFileSync(file, 'utf-8');
          mtimeMs = statSync(file).mtimeMs;
        } catch (err) {
          log.warn('skill read failed', { file, err });
          continue;
        }
        const entry = parseSkill(file, raw, scope, source);
        if (!entry) continue;
        // Dedup por nombre: el directorio posterior (más específico) gana.
        this.byName.set(entry.name, entry);
        parts.push(`${entry.name} ${file} ${mtimeMs} ${sha1(raw)}`);
      }
    }
    this.fingerprintValue = sha1(parts.join('\n'));
  }

  /** Skills descubiertas, ordenadas por nombre. */
  get entries(): SkillEntry[] {
    return [...this.byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  get fingerprint(): string {
    return this.fingerprintValue;
  }

  resolve(name: string): SkillEntry | undefined {
    return this.byName.get(name);
  }

  /** Bloque `# Skills` del system prompt. Cadena vacía si no hay skills. */
  promptBlock(cwd?: string): string {
    return buildSkillsBlock(this.entries, cwd);
  }

  /**
   * Materializa la tabla en `<registryFile>` (escritura atómica). No reescribe
   * si el fingerprint del fichero ya coincide — esa es la caché: el coste de
   * una sesión sin cambios en las skills es leer un fichero corto. Devuelve la
   * ruta escrita, o null si no había nada que escribir o falló.
   */
  writeRegistryFile(registryFile: string): string | null {
    const target = resolve(registryFile);
    if (this.byName.size === 0) return null;
    try {
      if (existsSync(target)) {
        const current = readFileSync(target, 'utf-8');
        const m = current.match(FINGERPRINT_RE);
        if (m && Number(m[1]) === SKILL_REGISTRY_SCHEMA && m[2] === this.fingerprintValue) {
          return target;
        }
      }
      mkdirSync(dirname(target), { recursive: true });
      const tmp = `${target}.${process.pid}.tmp`;
      writeFileSync(tmp, renderRegistryFile(this.entries, this.fingerprintValue), 'utf-8');
      renameSync(tmp, target);
      log.debug('skill registry written', { target, skills: this.byName.size });
      return target;
    } catch (err) {
      // El registro es auxiliar: un fallo de escritura nunca aborta la sesión.
      log.warn('skill registry write failed', { target, err });
      return null;
    }
  }
}

/** Lista los ficheros de skill de un directorio: `<dir>/<n>/SKILL.md` y `<dir>/<n>.md`. */
function listSkillFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  let names: string[];
  try {
    names = readdirSync(dir).sort();
  } catch (err) {
    log.warn('skill dir read failed', { dir, err });
    return [];
  }
  const out: string[] = [];
  for (const name of names) {
    const full = join(dir, name);
    let isDir = false;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (isDir) {
      const skillFile = join(full, 'SKILL.md');
      if (existsSync(skillFile)) out.push(skillFile);
      continue;
    }
    if (/\.md$/i.test(name) && !/^readme\.md$/i.test(name)) out.push(full);
  }
  return out;
}

/**
 * Parsea un fichero de skill. Una skill sin `description` sigue siendo válida
 * (el nombre ya es un disparador débil), pero el índice lo marca: una fila sin
 * trigger es una skill que el modelo no sabrá cuándo usar.
 */
export function parseSkill(
  path: string,
  raw: string,
  scope: SkillScope,
  source: string,
): SkillEntry | null {
  const { frontmatter } = splitFrontmatter(raw);
  const fmName = typeof frontmatter.name === 'string' ? frontmatter.name.trim() : '';
  const fmDesc = typeof frontmatter.description === 'string' ? frontmatter.description.trim() : '';
  const name = normalizeName(fmName || fallbackName(path));
  if (!name) return null;
  return { name, description: collapse(fmDesc), path, scope, source };
}

function fallbackName(path: string): string {
  const parts = path.split(/[\\/]/);
  const file = parts[parts.length - 1] ?? '';
  if (/^skill\.md$/i.test(file)) return parts[parts.length - 2] ?? '';
  return file.replace(/\.md$/i, '');
}

function normalizeName(name: string): string {
  return name.trim().replace(/\s+/g, '-').toLowerCase();
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Escapa el pipe: una descripción con `|` rompería la tabla markdown. */
function cell(text: string): string {
  return text.replace(/\|/g, '\\|');
}

function sha1(text: string): string {
  return createHash('sha1').update(text).digest('hex');
}

/**
 * Ruta mostrada al modelo: relativa al cwd cuando cae dentro (más corta y
 * usable tal cual por `read_file`), absoluta cuando no.
 */
export function displayPath(path: string, cwd?: string): string {
  if (!cwd) return path;
  const rel = relative(cwd, path);
  if (!rel || rel.startsWith('..')) return path;
  return rel.split(sep).join('/');
}

/**
 * Bloque `# Skills` del system prompt: solo el índice. El cuerpo NO se carga —
 * ese es el punto: el índice es barato y está siempre; el cuerpo se paga solo
 * cuando la tarea encaja con el disparador.
 */
export function buildSkillsBlock(entries: SkillEntry[], cwd?: string): string {
  if (entries.length === 0) return '';
  const rows = entries.map(
    (e) =>
      `| ${cell(e.name)} | ${cell(e.description || '(no description declared)')} | ${cell(
        displayPath(e.path, cwd),
      )} |`,
  );
  return `# Skills
These are task instructions written for this environment. Only the index is loaded here; the bodies are not.
Before starting work that matches one of the triggers below, read that file with read_file and follow it: it overrides your default approach for that task. If nothing matches, ignore this section and work normally. Never guess the content of a skill from its name.

| Skill | Use it when | Path |
|---|---|---|
${rows.join('\n')}`;
}

/** Contenido del fichero `.stratum/skill-registry.md`. */
export function renderRegistryFile(entries: SkillEntry[], fingerprint: string): string {
  const rows = entries.map(
    (e) =>
      `| ${cell(e.name)} | ${cell(e.description || '—')} | \`${cell(e.path)}\` | ${e.scope} | ${cell(
        e.source,
      )} |`,
  );
  return `${REGISTRY_HEADER}
<!-- stratum-skill-registry v${SKILL_REGISTRY_SCHEMA} fingerprint: ${fingerprint} -->

# Skill registry

${entries.length} skill(s) descubiertas. Precedencia: proyecto sobre usuario, \`.stratum/skills\` sobre \`.claude/skills\`.

| Skill | Cuándo usarla | Ruta | Ámbito | Origen |
|---|---|---|---|---|
${rows.join('\n')}
`;
}
