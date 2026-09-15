import { getLogger } from '../logging/index.js';
import { inheritedGitRoutingVars } from './env.js';

/**
 * Avisa una sola vez por proceso si el entorno trae variables de enrutado de
 * git. Se limpian en las invocaciones de git y en `exec` (ver `git/env.ts`),
 * pero el usuario merece saberlo: si lanzó Stratum desde un hook de git o desde
 * un `git rebase --exec`, lo que ve en `/changes` no es lo que su shell le
 * mostraría, y esa discrepancia es desconcertante sin explicación.
 */
export function warnInheritedGitRouting(env: NodeJS.ProcessEnv = process.env): string[] {
  const vars = inheritedGitRoutingVars(env);
  if (vars.length === 0) return [];
  getLogger('cli').warn('inherited git routing environment — ignored for git and exec', { vars });
  return vars;
}
