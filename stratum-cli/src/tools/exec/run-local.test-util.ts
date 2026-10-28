/**
 * Para los tests del backend local: `localBackend.run` en primer plano, con el
 * resultado estrechado a `ExecOutcome`. Sin `ctx.jobs` no hay traspaso posible.
 */
import type { ToolContext } from '../../agent/types.js';
import { isHandedOver, type ExecOutcome, type ExecRequest } from './backend.js';
import { localBackend } from './backends/local.js';
import type { ExecutionTarget } from './target.js';

export async function runLocal(
  target: ExecutionTarget,
  req: ExecRequest,
  ctx: ToolContext,
): Promise<ExecOutcome> {
  const out = await localBackend.run(target, req, ctx);
  if (isHandedOver(out)) throw new Error('unexpected handover in a foreground test');
  return out;
}
