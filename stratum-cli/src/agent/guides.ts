/**
 * Guías de prompt cargadas por puntero (§3 de la investigación `gentle-pi`).
 *
 * El patrón del original: el prompt siempre-activo contiene **punteros**, no
 * cuerpos. `orchestrator.md` son 96 líneas de índice que dicen «antes de tocar
 * SDD, lee `sdd-orchestrator-workflow.md`», y esas 338 líneas se cargan solo
 * cuando hacen falta. Es la misma economía que ya aplicamos a las skills:
 * índice barato siempre en contexto, cuerpo caro bajo demanda.
 *
 * Aquí aplica a los dos bloques que más han crecido en el system prompt —
 * `# Work routing` (Hito 11) y `# Testing discipline` (Hito 13) —, unas 90
 * líneas que hoy viajan en cada petición aunque el turno sea «arregla este
 * typo». Se materializan en `.stratum/guides/<nombre>.md` (escritura atómica
 * con fingerprint, como `skill-registry.md`) y el prompt se queda con una tabla
 * de tres columnas que el agente resuelve con `read_file`.
 *
 * El modo por defecto es `inline`, y la razón es deliberada: seguir un puntero
 * exige que el modelo decida leer un fichero antes de trabajar, y los modelos
 * pequeños que son el caso de uso de Stratum simplemente no lo hacen — se
 * quedan sin la disciplina que el bloque codificaba. El ahorro de contexto solo
 * compensa cuando el modelo es lo bastante bueno para seguir el puntero, así
 * que se activa con `prompt.guides: "pointers"` y no a la inversa.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';
import { dirname, join, relative, resolve } from 'path';
import type { StratumConfig } from '../config/schema.js';
import { getLogger } from '../logging/index.js';
import { buildTestingDisciplineBlock, buildWorkRoutingBlock } from './system-prompt.js';

const log = getLogger('agent.guides');

/** Versión del formato. Cambiarla invalida los ficheros ya materializados. */
export const GUIDE_SCHEMA = 1;

const FINGERPRINT_RE = /<!--\s*stratum-guide\s+v(\d+)\s+fingerprint:\s*([0-9a-f]+)\s*-->/;

export interface PromptGuide {
  /** Nombre del fichero sin extensión: `work-routing` → `work-routing.md`. */
  name: string;
  /** Título legible para la tabla de punteros. */
  title: string;
  /** Cuándo debe leerla el agente. Es la columna que decide si la abre o no. */
  when: string;
  /** Cuerpo completo, exactamente el bloque que iría inline. */
  body: string;
}

export interface GuideContext {
  /** Perfiles de subagente disponibles (decide si hay guía de enrutado). */
  agentProfiles?: string[];
  /** `tools.testCommand`: sin comando de tests no hay guía de TDD. */
  testCommand?: string;
  /** Un subagente no enruta trabajo: no recibe la guía de enrutado. */
  isSubagent?: boolean;
}

/**
 * Guías activas para este contexto. Las condiciones son exactamente las mismas
 * que deciden la inyección inline en `buildSystemPrompt` — si un bloque no se
 * inyectaría, tampoco se materializa ni se anuncia.
 */
export function activeGuides(ctx: GuideContext): PromptGuide[] {
  const guides: PromptGuide[] = [];

  if (!ctx.isSubagent) {
    const routing = buildWorkRoutingBlock(ctx.agentProfiles ?? []);
    if (routing) {
      guides.push({
        name: 'work-routing',
        title: 'Work routing',
        when: 'before starting any task: decide inline vs. delegate vs. formal plan',
        body: routing,
      });
    }
  }

  const testing = buildTestingDisciplineBlock(ctx.testCommand ?? '');
  if (testing) {
    guides.push({
      name: 'testing-discipline',
      title: 'Testing discipline',
      when: 'before writing or changing any test, and before your first edit to tested code',
      body: testing,
    });
  }

  return guides;
}

/** Fingerprint del cuerpo, para no reescribir un fichero que no cambió. */
function fingerprint(body: string): string {
  return createHash('sha1').update(`${GUIDE_SCHEMA}\n${body}`).digest('hex').slice(0, 16);
}

/** Contenido del fichero materializado: marca de agua + fingerprint + cuerpo. */
export function renderGuideFile(guide: PromptGuide): string {
  return `<!-- stratum-guide v${GUIDE_SCHEMA} fingerprint: ${fingerprint(guide.body)} -->
<!-- Generado por Stratum. No editar a mano: se reescribe al cambiar el prompt. -->

${guide.body.trim()}
`;
}

/**
 * Materializa una guía en `<dir>/<name>.md` (tmp + rename). Devuelve la ruta
 * escrita, o null si falló. Como el registro de skills, es auxiliar: un fallo
 * de escritura nunca aborta la sesión — el llamante cae a inline.
 */
export function writeGuideFile(dir: string, guide: PromptGuide): string | null {
  const target = resolve(join(dir, `${guide.name}.md`));
  try {
    if (existsSync(target)) {
      const m = readFileSync(target, 'utf-8').match(FINGERPRINT_RE);
      if (m && Number(m[1]) === GUIDE_SCHEMA && m[2] === fingerprint(guide.body)) return target;
    }
    mkdirSync(dirname(target), { recursive: true });
    const tmp = `${target}.${process.pid}.tmp`;
    writeFileSync(tmp, renderGuideFile(guide), 'utf-8');
    renameSync(tmp, target);
    log.debug('guide written', { target });
    return target;
  } catch (err) {
    log.warn('guide write failed', { target, err });
    return null;
  }
}

/** Ruta relativa al cwd con separadores POSIX, que es como el agente la escribe. */
function displayPath(path: string, cwd: string): string {
  const rel = relative(cwd, path);
  if (!rel || rel.startsWith('..')) return path.replace(/\\/g, '/');
  return `./${rel.replace(/\\/g, '/')}`;
}

/**
 * Tabla de punteros que sustituye a los cuerpos en el system prompt. El `when`
 * es lo único que el agente tiene para decidir, así que va antes de la ruta.
 */
export function buildGuideIndex(entries: Array<{ guide: PromptGuide; path: string }>): string {
  if (entries.length === 0) return '';
  const rows = entries.map(({ guide, path }) => `| ${guide.title} | ${guide.when} | \`${path}\` |`);
  return `# Operating guides
These guides are the binding rules for the situations they name. They are not in this prompt to keep it short: read the file with \`read_file\` when its trigger applies, BEFORE doing the work, and follow it as if it were written here.

| Guide | Read it when | File |
|---|---|---|
${rows.join('\n')}`;
}

/**
 * Prepara el bloque de punteros: materializa las guías activas y devuelve el
 * índice ya renderizado, listo para `SystemPromptEnv.guides`. Devuelve cadena
 * vacía si no hay guías activas o si ninguna se pudo escribir — y en ese caso
 * `buildSystemPrompt` inyecta los cuerpos inline, como siempre.
 */
export function prepareGuideIndex(
  config: StratumConfig,
  ctx: GuideContext,
  cwd: string = process.cwd(),
): string {
  if (config.prompt.guides !== 'pointers') return '';
  const guides = activeGuides(ctx);
  if (guides.length === 0) return '';

  const dir = resolve(cwd, config.prompt.guidesDir);
  const written: Array<{ guide: PromptGuide; path: string }> = [];
  for (const guide of guides) {
    const path = writeGuideFile(dir, guide);
    if (path) written.push({ guide, path: displayPath(path, cwd) });
  }
  // Si no se pudo escribir ninguna, el índice apuntaría a ficheros que no
  // existen: peor que el prompt largo. Se cae a inline devolviendo vacío.
  if (written.length !== guides.length) {
    log.warn('guide pointers incomplete, falling back to inline blocks', {
      written: written.length,
      total: guides.length,
    });
    return '';
  }
  return buildGuideIndex(written);
}
