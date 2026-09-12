/**
 * Hito 11 — capa 3 de las guardas aplicada a las tools de fichero.
 *
 * Es la protección que más probablemente muerda en la práctica: un agente
 * leyendo `.env` o `~/.ssh/id_ed25519` y volcando el contenido al provider.
 * Dos niveles, por decisión de producto:
 *
 *  - `blocked` (claves, certificados, credenciales, llaveros) → veto de
 *    `preflight`: inapelable, sin confirmación posible y sin allowlist.
 *  - `confirm` (.env, secrets/, .npmrc) → `isDestructive()`: pasa por el gate
 *    normal, porque son ficheros que sí se editan de forma legítima. Admite
 *    `tools.sensitivePathAllowlist`.
 */
import type { ToolContext, ToolResult } from '../../agent/types.js';
import { sensitivePathVerdict } from '../guards.js';

/** Veto de preflight para el nivel `blocked`. `null` si la ruta no lo alcanza. */
export function sensitivePathPreflight(params: unknown, ctx: ToolContext): ToolResult | null {
  const verdict = sensitivePathVerdict(params, ctx.config.tools.sensitivePathAllowlist);
  if (!verdict || verdict.tier !== 'blocked') return null;
  return {
    ok: false,
    error:
      `Access to "${verdict.path}" is blocked: ${verdict.reason}. ` +
      'Credentials and private key material are never read, written or edited by the agent, ' +
      'and no configuration or user approval can enable it. ' +
      'If you need a value from it, ask the user to provide just that value.',
    recoverable: false,
  };
}

/** ¿Requiere confirmación del usuario por ser una ruta sensible del nivel `confirm`? */
export function sensitivePathNeedsConfirm(params: unknown, ctx: ToolContext): boolean {
  const verdict = sensitivePathVerdict(params, ctx.config.tools.sensitivePathAllowlist);
  return verdict?.tier === 'confirm';
}
