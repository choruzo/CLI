/**
 * Expansión de `${VAR}` en la config. Sin imports a propósito: el wizard de
 * providers de Stratum Desktop importa `wizard-logic.ts` desde el webview, y
 * tenerlo en `loader.ts` (que usa `fs`, `os` y `path` al cargar el módulo)
 * metía Node en el bundle del frontend y lo dejaba en blanco al arrancar.
 */

/** Variable `${VAR}` referenciada en la config que no está definida. */
export interface MissingEnvVar {
  name: string;
  /** Dot-path de la clave donde aparece. */
  path: string;
}

/**
 * Sustituye `${VAR}` por su valor de entorno. Una variable no definida se
 * sustituye por `''` (una key de un provider que no se usa no debe impedir
 * arrancar), pero se informa por `onMissing` para poder avisar.
 */
export function expandEnvVars(
  obj: unknown,
  onMissing?: (missing: MissingEnvVar) => void,
  path = '',
): unknown {
  if (typeof obj === 'string') {
    return obj.replace(/\$\{([^}]+)\}/g, (_, varName: string) => {
      const value = process.env[varName];
      if (value === undefined) onMissing?.({ name: varName, path });
      return value ?? '';
    });
  }
  if (Array.isArray(obj)) {
    return obj.map((v, i) => expandEnvVars(v, onMissing, path ? `${path}.${i}` : String(i)));
  }
  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      result[key] = expandEnvVars(value, onMissing, path ? `${path}.${key}` : key);
    }
    return result;
  }
  return obj;
}
