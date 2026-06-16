import { z } from 'zod';
import type { ToolContext, ToolDefinition, ToolResult } from '../../agent/types.js';
import { getDecisionMemory } from '../../memory/decision-memory.js';

const schema = z.object({
  query: z.string().describe('Consulta en lenguaje natural sobre decisiones técnicas pasadas'),
  k: z
    .number()
    .int()
    .positive()
    .max(20)
    .optional()
    .describe('Número máximo de decisiones a recuperar (default: retrievalTopK de config)'),
});

export const recallDecisionsTool: ToolDefinition = {
  name: 'recall_decisions',
  description:
    'Recupera decisiones técnicas relevantes almacenadas en sesiones anteriores mediante búsqueda semántica.\n' +
    'Úsala cuando necesites recordar por qué se eligió una tecnología, una convención del proyecto, ' +
    'la solución a un bug previo o una preferencia del usuario antes de actuar.',
  schema,
  destructive: false,

  async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
    const { query, k } = schema.parse(params);
    try {
      const memory = getDecisionMemory(ctx.config);
      const results = await memory.search(query, k);
      if (results.length === 0) {
        return { ok: true, output: 'No se encontraron decisiones relevantes en la memoria.' };
      }
      const body = results
        .map((r, i) => {
          const d = r.record;
          return (
            `${i + 1}. [${d.type}/${d.importance}] ${d.title} (score ${r.score.toFixed(2)}, id ${d.id})\n` +
            `   ${d.content}` +
            (d.tags.length ? `\n   tags: ${d.tags.join(', ')}` : '')
          );
        })
        .join('\n\n');
      return { ok: true, output: body };
    } catch (err) {
      return {
        ok: false,
        error: `No se pudo recuperar memoria: ${(err as Error).message}`,
        recoverable: true,
      };
    }
  },
};
