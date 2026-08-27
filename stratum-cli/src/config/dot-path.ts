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
  const keys = path.split('.');
  let current: Record<string, unknown> = obj;

  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i]!;
    if (!(key in current) || typeof current[key] !== 'object' || current[key] === null) {
      current[key] = {};
    }
    current = current[key] as Record<string, unknown>;
  }

  const lastKey = keys[keys.length - 1]!;
  // Try to coerce common types
  if (value === 'true') current[lastKey] = true;
  else if (value === 'false') current[lastKey] = false;
  else if (typeof value === 'string' && !isNaN(Number(value)) && value.trim() !== '') {
    current[lastKey] = Number(value);
  } else {
    current[lastKey] = value;
  }
}

/** Formatea un valor de config para mostrarlo al usuario (objetos como JSON). */
export function formatConfigValue(value: unknown): string {
  return typeof value === 'object' && value !== null
    ? JSON.stringify(value, null, 2)
    : String(value);
}
