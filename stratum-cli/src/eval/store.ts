/**
 * Resultados de `stratum eval` en disco: `<evals>/runs/<runId>/result.json`
 * junto a las trazas y salidas de cada escenario. Local, como las trazas.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { expandHome } from '../config/paths.js';
import { stripBom } from '../config/json-text.js';
import { isEvalResult, type EvalResult } from './result.js';

export const DEFAULT_EVALS_DIR = '~/.stratum/evals';

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
  /** Carpeta que contiene el `result.json` (y las trazas). */
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

/**
 * Resuelve una referencia a un resultado: `latest`, `previous`, un `runId`, o
 * la ruta de un `result.json` o de su carpeta.
 */
export function resolveResult(ref: string, dir: string): StoredResult {
  const ids = listRunIds(dir);
  const alias = ref === 'latest' ? ids[0] : ref === 'previous' ? ids[1] : undefined;
  if (ref === 'latest' || ref === 'previous') {
    if (!alias) throw new Error(`No hay ejecución "${ref}" en ${dir}.`);
    return readResult(join(dir, 'runs', alias, 'result.json'));
  }
  if (ids.includes(ref)) return readResult(join(dir, 'runs', ref, 'result.json'));
  const path = resolve(ref);
  if (existsSync(path)) {
    return readResult(statSync(path).isDirectory() ? join(path, 'result.json') : path);
  }
  throw new Error(
    `No se encuentra el resultado "${ref}": ni es una ejecución de ${dir} ni una ruta. ` +
      'Usa latest, previous, un runId o la ruta de un result.json.',
  );
}
