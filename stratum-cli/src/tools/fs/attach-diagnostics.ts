import type { DiagnosticsProvider, ToolContext } from '../../agent/types.js';
import { getLogger } from '../../logging/index.js';

const log = getLogger('tools');

/**
 * Anexo de diagnósticos LSP al resultado de una edición (UX-2b).
 *
 * El contrato es deliberadamente blando: si no hay provider, si devuelve `null`,
 * si tarda de más o si lanza, el resultado de la tool queda **exactamente** como
 * estaba. Un fallo auxiliar no es un error del agente: la edición ya está en
 * disco y el modelo no debe reintentarla por culpa del language server.
 */
export async function withDiagnostics(
  output: string,
  absPath: string,
  text: string,
  ctx: ToolContext,
): Promise<string> {
  const provider: DiagnosticsProvider | undefined = ctx.diagnostics;
  if (provider === undefined) return output;
  try {
    const report = await provider.diagnose(absPath, text, ctx.signal);
    if (report === null || report.trim() === '') return output;
    return `${output}\n\n${report}`;
  } catch (err) {
    // Auxiliar de verdad: se anota y la edición queda como estaba.
    log.debug('diagnostics provider failed; editing result unchanged', {
      path: absPath,
      error: (err as Error).message,
    });
    return output;
  }
}
