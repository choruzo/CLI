/**
 * Versionado de los ficheros que comparten la CLI y Stratum Desktop
 * (`.stratumrc.json` y las sesiones de `SessionStore`), punto ciego 15.6 de
 * `STRATUM_DESKTOP_PROJECT_DEFINITION.md`.
 *
 * El sidecar de Desktop es una versión del core **pineada** con la app, y la CLI
 * global del usuario puede ser más nueva o más vieja. Los dos escriben en los
 * mismos ficheros, así que cada uno tiene que reconocer cuándo el fichero lo
 * escribió un Stratum que entiende un formato que él no conoce y parar con un
 * mensaje claro, en vez de validarlo a medias y perder campos al reescribirlo.
 *
 * Reglas:
 * - Sin `schemaVersion` → versión 1: todo lo escrito antes de que existiera el campo.
 * - Versión ≤ la soportada → compatible. Si algún día sube, las migraciones
 *   hacia adelante se aplican en la carga (como ya hace `migrateLegacyKeys`).
 * - Versión > la soportada → incompatible: el fichero es de un Stratum más nuevo.
 */

/** Versión del formato de `.stratumrc.json` que entiende este core. */
export const CONFIG_SCHEMA_VERSION = 1;

/** Versión del formato de sesión guardada (`~/.stratum/sessions/*.json`). */
export const SESSION_SCHEMA_VERSION = 1;

export type SchemaKind = 'config' | 'session';

export type SchemaVersionCheck =
  | { ok: true; version: number }
  | { ok: false; version: unknown; reason: 'newer' | 'invalid' };

/** Clasifica el `schemaVersion` leído de un fichero contra la versión soportada. */
export function checkSchemaVersion(value: unknown, supported: number): SchemaVersionCheck {
  if (value === undefined) return { ok: true, version: 1 };
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    return { ok: false, version: value, reason: 'invalid' };
  }
  if (value > supported) return { ok: false, version: value, reason: 'newer' };
  return { ok: true, version: value };
}

/**
 * Error tipado para que un consumidor (el sidecar de Desktop) lo distinga de un
 * JSON roto o de una validación Zod y lo reporte como incompatibilidad.
 */
export class SchemaVersionError extends Error {
  readonly kind: SchemaKind;
  readonly source: string;
  readonly found: unknown;
  readonly supported: number;

  constructor(kind: SchemaKind, source: string, found: unknown, supported: number) {
    super(describeIncompatibility(kind, source, found, supported));
    this.name = 'SchemaVersionError';
    this.kind = kind;
    this.source = source;
    this.found = found;
    this.supported = supported;
  }
}

function describeIncompatibility(
  kind: SchemaKind,
  source: string,
  found: unknown,
  supported: number,
): string {
  const what = kind === 'config' ? 'La configuración' : 'La sesión';
  if (typeof found === 'number' && Number.isInteger(found) && found > supported) {
    return (
      `${what} ${source} usa schemaVersion ${found}, pero este Stratum solo entiende ` +
      `hasta la ${supported}. La escribió una versión más nueva de Stratum: ` +
      'actualiza esta instalación antes de usarla, o no la modificarás sin perder datos.'
    );
  }
  return (
    `${what} ${source} tiene un schemaVersion inválido (${JSON.stringify(found)}): ` +
    'debe ser un entero positivo.'
  );
}

/** Lanza `SchemaVersionError` si el valor no es compatible; devuelve la versión efectiva. */
export function assertSchemaVersion(value: unknown, kind: SchemaKind, source: string): number {
  const supported = kind === 'config' ? CONFIG_SCHEMA_VERSION : SESSION_SCHEMA_VERSION;
  const check = checkSchemaVersion(value, supported);
  if (!check.ok) throw new SchemaVersionError(kind, source, value, supported);
  return check.version;
}
