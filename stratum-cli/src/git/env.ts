/**
 * Saneado del entorno de git heredado (§3 de la investigación `gentle-pi`).
 *
 * Git enruta por entorno: si `GIT_DIR` o `GIT_WORK_TREE` están puestos, *toda*
 * invocación de git opera sobre ese repositorio, ignorando el `cwd` que se le
 * pase. Eso pasa más de lo que parece — Stratum lanzado desde un hook de git,
 * desde un `git rebase --exec`, o desde un shell donde el usuario exportó las
 * variables para otra cosa — y el síntoma es desconcertante: el panel de
 * `/changes` mide un repo, el agente cree estar en otro, y un `git add` acaba
 * en el árbol equivocado.
 *
 * Por eso las invocaciones internas de git y los comandos de `exec` en local corren con
 * las variables de **enrutado** eliminadas, de modo que el `cwd` sea la única
 * fuente de verdad.
 *
 * Desviación deliberada del original: `gentle-pi` borra todas las `GIT_*`.
 * Aquí se borra solo el enrutado, con una lista explícita. Variables como
 * `GIT_SSH_COMMAND`, `GIT_EDITOR` o las de credenciales son configuración
 * legítima del usuario que hace falta para que un `git push` funcione; borrarlas
 * cambia el comportamiento de git sin proteger nada.
 */

/**
 * Variables que redirigen a git a otro repositorio, índice u objeto. Nombres
 * exactos, salvo `GIT_CONFIG_*` que es una familia indexada
 * (`GIT_CONFIG_COUNT`/`KEY_n`/`VALUE_n`) y se trata por prefijo.
 */
export const GIT_ROUTING_VARS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CEILING_DIRECTORIES',
  'GIT_DISCOVERY_ACROSS_FILESYSTEM',
  'GIT_NAMESPACE',
  'GIT_PREFIX',
  'GIT_CONFIG',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_SYSTEM',
] as const;

const GIT_CONFIG_FAMILY = /^GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+)$/;

/** True si `name` es una variable de enrutado de git. */
export function isGitRoutingVar(name: string): boolean {
  return (GIT_ROUTING_VARS as readonly string[]).includes(name) || GIT_CONFIG_FAMILY.test(name);
}

/**
 * Copia de `env` sin las variables de enrutado de git. No muta la entrada y no
 * toca nada más: lo que no enruta, se hereda tal cual.
 */
export function scrubGitEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (isGitRoutingVar(key)) continue;
    out[key] = value;
  }
  return out;
}

/** Nombres de enrutado presentes en `env`. Para diagnóstico y logs. */
export function inheritedGitRoutingVars(env: NodeJS.ProcessEnv = process.env): string[] {
  return Object.keys(env)
    .filter((k) => isGitRoutingVar(k))
    .sort();
}
