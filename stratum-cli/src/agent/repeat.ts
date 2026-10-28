/**
 * Llamadas repetidas: la misma tool con los mismos argumentos que una llamada
 * anterior del mismo agente y turno, sin que entre las dos se haya ejecutado
 * nada que cambie el estado. Releer un fichero tras editarlo no cuenta;
 * releerlo dos veces seguidas, o relanzar tal cual el comando que acaba de
 * fallar, sí.
 *
 * Una sola regla para dos consumidores: el aviso del loop (`ReactLoop`, que
 * anexa `formatRepeatNotice` y lo traza con `TraceScope.runtime`) y la métrica
 * `repeatedCalls` de `stratum eval` (`countRepeatedCalls`). Si cambia aquí,
 * cambian los dos.
 */
import { isJobTool } from '../jobs/types.js';
import { canonicalJson } from '../tools/canonical-json.js';

/** Tools que solo observan: repetirlas sin un cambio entre medias no aporta nada. */
export const OBSERVING_TOOLS: ReadonlySet<string> = new Set([
  'read_file',
  'glob',
  'grep',
  'list_directory',
  'web_search',
  'web_fetch',
  'recall_decisions',
]);

/** La ventana de un agente en un turno. */
export class RepeatTracker {
  private readonly seen = new Map<string, number>();

  /**
   * Registra una llamada ejecutada y devuelve cuántas idénticas la precedieron
   * en la ventana (0 = no es repetida). Una tool que no solo observa cierra la
   * ventana: lo de antes ya no describe el estado, salvo ella misma.
   */
  observe(name: string, input: unknown): number {
    // Las tools de jobs se repiten con los mismos argumentos por diseño: cada
    // `get_job_output(jobId)` devuelve lo que hay de nuevo.
    if (isJobTool(name)) return 0;
    const key = `${name}:${JSON.stringify(canonicalJson(input ?? null))}`;
    const previous = this.seen.get(key) ?? 0;
    if (!OBSERVING_TOOLS.has(name)) this.seen.clear();
    this.seen.set(key, previous + 1);
    return previous;
  }

  /** Cierra la ventana sin registrar nada (algo ajeno al lote cambió el estado). */
  reset(): void {
    this.seen.clear();
  }
}

/**
 * Aviso para el modelo, anexado al final del lote. No veta nada: la llamada ya
 * se ejecutó. Solo nombres de tool, nunca sus argumentos.
 */
export function formatRepeatNotice(repeats: readonly { tool: string; count: number }[]): string {
  const lines = repeats.map(
    (r) =>
      `- \`${r.tool}\` was called with exactly the same arguments as ${
        r.count === 1 ? 'an earlier call' : `${r.count} earlier calls`
      } in this turn, and nothing that changes state ran in between.`,
  );
  return [
    '<repeated_tool_call>',
    ...lines,
    'The result is the same as before. Use the earlier output, or change the approach instead of repeating the call.',
    '</repeated_tool_call>',
  ].join('\n');
}
