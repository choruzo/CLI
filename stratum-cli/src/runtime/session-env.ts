/**
 * Entorno de una sesión: desde dónde trabaja y con qué variables. Es lo que una
 * sesión recibe **explícitamente** de quien la aloja, en lugar de leer
 * `process.cwd()` / `process.env` por su cuenta: así varias sesiones pueden
 * convivir en un proceso, cada una con el suyo (PRD de Stratum Dot, M0).
 *
 * `env` es material sensible (tokens, credenciales, rutas). No se emite en
 * eventos, ni se escribe en trazas o logs, ni se persiste con la sesión. Por
 * eso el objeto que crea `createSessionEnv` lo lleva como propiedad **no
 * enumerable** y con un `toJSON` que lo omite: serializarlo, copiarlo con
 * spread o pasarlo como campo de un log solo deja ver el `cwd`.
 */
export interface SessionEnv {
  /** Directorio de trabajo absoluto de la sesión. */
  readonly cwd: string;
  /** Variables de entorno con las que la sesión lanza procesos. No enumerable. */
  readonly env: Readonly<NodeJS.ProcessEnv>;
}

export function createSessionEnv(init: { cwd: string; env: NodeJS.ProcessEnv }): SessionEnv {
  const out = { cwd: init.cwd } as { cwd: string; env: Readonly<NodeJS.ProcessEnv> };
  Object.defineProperty(out, 'env', { value: init.env, enumerable: false, writable: false });
  Object.defineProperty(out, 'toJSON', {
    value: () => ({ cwd: init.cwd }),
    enumerable: false,
    writable: false,
  });
  return Object.freeze(out);
}

/**
 * El entorno del proceso actual. Es el **único** sitio fuera de `cli/` donde se
 * consulta `process.cwd()` para una sesión: lo usan los anfitriones de un solo
 * proceso (la CLI) y los puntos de entrada que admiten no recibir uno (tests,
 * un `ReactLoop` suelto). Se lee en cada llamada: no se cachea.
 */
export function processSessionEnv(): SessionEnv {
  return createSessionEnv({ cwd: process.cwd(), env: process.env });
}
