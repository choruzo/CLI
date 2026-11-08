/**
 * M19 fase 4 — escribe las representaciones de una memoria en `wiki/`, junto a
 * su `decisions.json`. Derivadas y regenerables: nunca se leen para decidir
 * nada. Reglas:
 *  - solo memorias con secciones; en `coding` no hace nada;
 *  - escritura atómica por página y solo si el contenido cambió;
 *  - solo se pisa o se borra un fichero que lleve `GENERATED_MARK`: lo que una
 *    persona dejó en esa carpeta no se toca;
 *  - el texto pasa por la redacción de secretos antes de escribirse;
 *  - un fallo de disco no lanza: se cuenta en `errors`.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'fs';
import { dirname, join } from 'path';
import type { StratumConfig } from '../../config/schema.js';
import { writeFileAtomic } from '../../config/writer.js';
import { resolveMemoryPaths } from '../../config/paths.js';
import { getLogger } from '../../logging/index.js';
import { redactText } from '../../security/redact-output.js';
import type { DecisionRecord, MemoryTaxonomy } from '../decisions.js';
import { buildPages, GENERATED_MARK } from './build.js';

const log = getLogger('memory').child('representations');

export interface SyncResult {
  /** `false` si la memoria no tiene secciones (nada que generar). */
  applicable: boolean;
  dir: string;
  written: number;
  unchanged: number;
  removed: number;
  /** Ficheros de `wiki/` que no son nuestros y se dejaron como estaban. */
  foreign: number;
  errors: number;
}

export function wikiDir(config: StratumConfig): string {
  return join(dirname(resolveMemoryPaths(config).decisionsFile), 'wiki');
}

function isGenerated(path: string): boolean {
  try {
    return readFileSync(path, 'utf-8').startsWith(GENERATED_MARK);
  } catch {
    return false;
  }
}

export function syncRepresentations(
  config: StratumConfig,
  notes: readonly DecisionRecord[],
  taxonomy: MemoryTaxonomy,
): SyncResult {
  const dir = wikiDir(config);
  const result: SyncResult = {
    applicable: taxonomy === 'sections',
    dir,
    written: 0,
    unchanged: 0,
    removed: 0,
    foreign: 0,
    errors: 0,
  };
  if (!result.applicable) return result;

  try {
    mkdirSync(dir, { recursive: true });
    const pages = buildPages(notes).map((p) => ({
      file: p.file,
      content: redactText(p.content, config),
    }));
    const wanted = new Set(pages.map((p) => p.file));

    for (const page of pages) {
      const path = join(dir, page.file);
      try {
        if (existsSync(path)) {
          const current = readFileSync(path, 'utf-8');
          if (current === page.content) {
            result.unchanged++;
            continue;
          }
          if (!current.startsWith(GENERATED_MARK)) {
            // Un fichero de una persona con el nombre de una página nuestra: no se pisa.
            result.foreign++;
            continue;
          }
        }
        writeFileAtomic(path, page.content);
        result.written++;
      } catch (err) {
        result.errors++;
        log.warn('wiki page not written', { err: String(err).slice(0, 200) });
      }
    }

    for (const name of readdirSync(dir)) {
      if (wanted.has(name) || !name.endsWith('.md')) continue;
      const path = join(dir, name);
      if (!isGenerated(path)) {
        result.foreign++;
        continue;
      }
      try {
        rmSync(path);
        result.removed++;
      } catch (err) {
        result.errors++;
        log.warn('stale wiki page not removed', { err: String(err).slice(0, 200) });
      }
    }
  } catch (err) {
    result.errors++;
    log.warn('wiki sync failed', { err: String(err).slice(0, 200) });
  }
  // Recuentos, nunca texto de la memoria.
  log.debug('wiki synced', {
    written: result.written,
    unchanged: result.unchanged,
    removed: result.removed,
    errors: result.errors,
  });
  return result;
}
