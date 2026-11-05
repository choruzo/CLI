/**
 * Acceso a `.stratumrc.json` por clave dot-path (`provider.default`,
 * `tools.webSearch.backend`…). Extraído de `cli/commands/config.ts` (Hito 10)
 * para poder reutilizarlo desde `/config get|set` en el chat sin duplicar la
 * coerción de tipos, que es la parte fácil de desincronizar entre las dos vías.
 */

/** Resuelve una clave dot-path. Devuelve `undefined` si algún tramo no existe. */
export function getByDotPath(obj: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((current, key) => {
    if (current !== null && typeof current === 'object') {
      return (current as Record<string, unknown>)[key];
    }
    return undefined;
  }, obj);
}

/**
 * Escribe una clave dot-path creando los objetos intermedios que falten.
 * Los valores llegan siempre como string (vienen de la CLI o del input del
 * chat), así que se coercionan `true`/`false` y los numéricos.
 */
export function setByDotPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  assignByDotPath(obj, path, coerceConfigText(value));
}

/** `true`/`false` y los numéricos de un valor que llega como texto. */
export function coerceConfigText(value: unknown): unknown {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (typeof value === 'string' && !isNaN(Number(value)) && value.trim() !== '') {
    return Number(value);
  }
  return value;
}

function splitKey(path: string): string[] {
  const keys = path.split('.');
  // `a..b` o `.a` crearían claves vacías, y `__proto__` escribiría en el
  // prototipo de Object en vez de en la config.
  for (const key of keys) {
    if (key === '' || key === '__proto__' || key === 'constructor' || key === 'prototype') {
      throw new Error(`Clave de config no válida: "${path}"`);
    }
  }
  return keys;
}

/** Como `setByDotPath`, sin coerción: el valor se guarda tal cual. */
export function assignByDotPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const keys = splitKey(path);
  let current: Record<string, unknown> = obj;

  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i]!;
    if (!(key in current) || typeof current[key] !== 'object' || current[key] === null) {
      current[key] = {};
    }
    current = current[key] as Record<string, unknown>;
  }

  current[keys[keys.length - 1]!] = value;
}

/**
 * Quita una clave dot-path y los objetos que queden vacíos por ello, para que
 * la clave vuelva a heredarse de la capa de abajo. Devuelve si existía.
 */
export function unsetByDotPath(obj: Record<string, unknown>, path: string): boolean {
  const keys = splitKey(path);
  const parents: Record<string, unknown>[] = [obj];
  for (const key of keys.slice(0, -1)) {
    const next = parents[parents.length - 1]![key];
    if (next === null || typeof next !== 'object' || Array.isArray(next)) return false;
    parents.push(next as Record<string, unknown>);
  }
  const leaf = keys[keys.length - 1]!;
  const owner = parents[parents.length - 1]!;
  if (!Object.prototype.hasOwnProperty.call(owner, leaf)) return false;
  delete owner[leaf];
  for (let i = parents.length - 1; i > 0; i--) {
    if (Object.keys(parents[i]!).length > 0) break;
    delete parents[i - 1]![keys[i - 1]!];
  }
  return true;
}

/** Formatea un valor de config para mostrarlo al usuario (objetos como JSON). */
export function formatConfigValue(value: unknown): string {
  return typeof value === 'object' && value !== null
    ? JSON.stringify(value, null, 2)
    : String(value);
}
