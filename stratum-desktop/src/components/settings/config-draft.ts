import type { ConfigIssue } from '../../ipc/types';

/**
 * Borrador de la config en Ajustes (D5). La fuente de verdad es el **texto**
 * JSON (el mismo que edita Avanzado); los formularios lo parsean, cambian una
 * clave y lo vuelven a serializar. Así las dos vistas nunca divergen y una
 * clave que los formularios no conocen (`ssh`, `mcp`…) se conserva intacta.
 * Puro, para los tests.
 */

export type Json = Record<string, unknown>;

export const isObject = (v: unknown): v is Json =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

export function parseDraft(text: string): { ok: true; value: Json } | { ok: false; error: string } {
  if (text.trim() === '') return { ok: true, value: {} };
  try {
    const value = JSON.parse(text) as unknown;
    if (!isObject(value)) return { ok: false, error: 'La config tiene que ser un objeto JSON.' };
    return { ok: true, value };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function stringifyDraft(value: Json): string {
  return JSON.stringify(value, null, 2);
}

export function getIn(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!isObject(current)) return undefined;
    current = current[key];
  }
  return current;
}

/**
 * Copia con `path` puesto a `value`. `undefined` borra la clave (la config
 * vuelve al valor por defecto) y poda los objetos que se quedan vacíos.
 */
export function setIn(value: Json, path: readonly string[], next: unknown): Json {
  const [key, ...rest] = path;
  if (key === undefined) return value;
  const out: Json = { ...value };
  if (rest.length === 0) {
    if (next === undefined) delete out[key];
    else out[key] = next;
    return out;
  }
  const child = isObject(out[key]) ? (out[key] as Json) : {};
  const updated = setIn(child, rest, next);
  if (Object.keys(updated).length === 0) delete out[key];
  else out[key] = updated;
  return out;
}

/** Aplica `fn` al borrador; `null` si el texto no es JSON (hay que arreglarlo en Avanzado). */
export function editDraft(text: string, fn: (value: Json) => Json): string | null {
  const parsed = parseDraft(text);
  if (!parsed.ok) return null;
  return stringifyDraft(fn(parsed.value));
}

export interface ProviderEntry {
  name: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  contextWindow: number | undefined;
}

export function providersOf(value: Json): ProviderEntry[] {
  const providers = getIn(value, ['provider', 'providers']);
  if (!isObject(providers)) return [];
  return Object.entries(providers).flatMap(([name, p]) =>
    isObject(p)
      ? [
          {
            name,
            baseUrl: typeof p.baseUrl === 'string' ? p.baseUrl : '',
            model: typeof p.model === 'string' ? p.model : '',
            apiKey: typeof p.apiKey === 'string' ? p.apiKey : '',
            contextWindow: typeof p.contextWindow === 'number' ? p.contextWindow : undefined,
          },
        ]
      : [],
  );
}

export function defaultProvider(value: Json): string | null {
  const d = getIn(value, ['provider', 'default']);
  return typeof d === 'string' ? d : null;
}

/** Añade o sustituye un provider sin tocar los demás (como `upsertProvider` de la CLI). */
export function upsertProvider(
  value: Json,
  name: string,
  entry: Json,
  makeDefault: boolean,
): Json {
  let next = setIn(value, ['provider', 'providers', name], entry);
  const current = defaultProvider(next);
  if (makeDefault || !current || !providersOf(next).some((p) => p.name === current)) {
    next = setIn(next, ['provider', 'default'], name);
  }
  return next;
}

/** Quita un provider; si era el default, lo pasa al primero que quede (como la CLI). */
export function removeProvider(value: Json, name: string): Json {
  let next = setIn(value, ['provider', 'providers', name], undefined);
  const rest = providersOf(next);
  if (rest.length === 0) return setIn(next, ['provider'], undefined);
  if (defaultProvider(next) === name) next = setIn(next, ['provider', 'default'], rest[0].name);
  return next;
}

/** Problemas de una clave y de todo lo que cuelga de ella. */
export function issuesFor(issues: readonly ConfigIssue[], path: string): ConfigIssue[] {
  return issues.filter(
    (i) => i.path === path || i.path.startsWith(`${path}.`) || (path === '' && i.path === ''),
  );
}

/** Texto de un campo numérico → valor de la config (`undefined` = por defecto). */
export function numberField(raw: string): number | undefined | null {
  const t = raw.trim().replace(',', '.');
  if (t === '') return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}
