/**
 * Resultados de `stratum eval` en disco: `<evals>/runs/<runId>/result.json`
 * junto a las trazas y salidas de cada escenario, y `<evals>/baselines/<nombre>.json`
 * con las ejecuciones guardadas como referencia. Local, como las trazas.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { writeFileAtomic } from '../config/writer.js';
import { expandHome } from '../config/paths.js';
import { stripBom } from '../config/json-text.js';
import type { ToleranceOverrides } from './compare.js';
import { isEvalResult, type EvalResult } from './result.js';

export const DEFAULT_EVALS_DIR = '~/.stratum/evals';
export const DEFAULT_BASELINE_NAME = 'baseline';

/** Referencias con significado propio: no pueden ser el nombre de un baseline. */
const RESERVED_REFS = new Set(['latest', 'current', 'previous']);
const BASELINE_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function evalsDir(override?: string): string {
  return resolve(expandHome(override ?? DEFAULT_EVALS_DIR));
}

/** Ids de las ejecuciones guardadas, la más reciente primero. */
export function listRunIds(dir: string): string[] {
  try {
    return readdirSync(join(dir, 'runs'))
      .filter((name) => existsSync(join(dir, 'runs', name, 'result.json')))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

export interface StoredResult {
  result: EvalResult;
  /** Carpeta que contiene el fichero del resultado (y, en una ejecución, las trazas). */
  dir: string;
}

function readResult(file: string): StoredResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripBom(readFileSync(file, 'utf8')));
  } catch (err) {
    throw new Error(`${file}: no se pudo leer (${err instanceof Error ? err.message : err})`);
  }
  if (!isEvalResult(parsed)) throw new Error(`${file}: no es un resultado de stratum eval`);
  return { result: parsed, dir: dirname(file) };
}

// ---------------------------------------------------------------------------
// Baselines con nombre
// ---------------------------------------------------------------------------

/** Motivo por el que `name` no sirve como nombre de baseline, o null. */
export function baselineNameProblem(name: string): string | null {
  if (RESERVED_REFS.has(name)) return `"${name}" es una referencia reservada`;
  if (!BASELINE_NAME.test(name)) {
    return `"${name}": usa minúsculas, dígitos, punto, guion y guion bajo (máx. 64)`;
  }
  return null;
}

const baselineFile = (dir: string, name: string): string => join(dir, 'baselines', `${name}.json`);

export interface SaveBaselineOptions {
  note?: string;
  tolerances?: ToleranceOverrides;
  now?: number;
}

/**
 * Guarda una copia del resultado como baseline. Es una copia y no un puntero:
 * borrar la ejecución de origen no deja la referencia colgando. Las trazas no
 * se copian; `baseline.runId` dice de qué ejecución salió.
 */
export function saveBaseline(
  dir: string,
  name: string,
  result: EvalResult,
  opts: SaveBaselineOptions = {},
): { file: string; replaced: boolean } {
  const problem = baselineNameProblem(name);
  if (problem) throw new Error(problem);
  const file = baselineFile(dir, name);
  const replaced = existsSync(file);
  mkdirSync(dirname(file), { recursive: true });
  const stored: EvalResult = {
    ...result,
    baseline: {
      name,
      savedAt: new Date(opts.now ?? Date.now()).toISOString(),
      runId: result.runId,
      ...(opts.note ? { note: opts.note } : {}),
      ...(opts.tolerances && Object.keys(opts.tolerances).length > 0
        ? { tolerances: opts.tolerances }
        : {}),
    },
  };
  writeFileAtomic(file, JSON.stringify(stored, null, 2) + '\n');
  return { file, replaced };
}

/** Nombres de los baselines guardados, por orden alfabético. */
export function listBaselines(dir: string): string[] {
  try {
    return readdirSync(join(dir, 'baselines'))
      .filter((name) => name.endsWith('.json'))
      .map((name) => name.slice(0, -'.json'.length))
      .filter((name) => baselineNameProblem(name) === null)
      .sort();
  } catch {
    return [];
  }
}

export function readBaseline(dir: string, name: string): StoredResult {
  return readResult(baselineFile(dir, name));
}

export function deleteBaseline(dir: string, name: string): boolean {
  const file = baselineFile(dir, name);
  if (baselineNameProblem(name) !== null || !existsSync(file)) return false;
  rmSync(file);
  return true;
}

/**
 * Resuelve una referencia a un resultado: `latest` (o `current`), `previous`,
 * un `runId`, el nombre de un baseline (también `baseline:<nombre>`), o la ruta
 * de un `result.json` o de su carpeta.
 */
export function resolveResult(ref: string, dir: string): StoredResult {
  const ids = listRunIds(dir);
  if (RESERVED_REFS.has(ref)) {
    const id = ref === 'previous' ? ids[1] : ids[0];
    if (!id) throw new Error(`No hay ejecución "${ref}" en ${dir}.`);
    return readResult(join(dir, 'runs', id, 'result.json'));
  }
  if (ids.includes(ref)) return readResult(join(dir, 'runs', ref, 'result.json'));

  const explicit = ref.startsWith('baseline:');
  const name = explicit ? ref.slice('baseline:'.length) : ref;
  if (baselineNameProblem(name) === null && existsSync(baselineFile(dir, name))) {
    return readBaseline(dir, name);
  }
  if (!explicit) {
    const path = resolve(ref);
    if (existsSync(path)) {
      return readResult(statSync(path).isDirectory() ? join(path, 'result.json') : path);
    }
  }
  const known = listBaselines(dir);
  throw new Error(
    `No se encuentra el resultado "${ref}": ni es una ejecución ni un baseline de ${dir}, ni una ` +
      `ruta. Usa latest, previous, un runId, la ruta de un result.json o un baseline` +
      (known.length > 0 ? ` (${known.join(', ')}).` : ' (no hay ninguno guardado).'),
  );
}
