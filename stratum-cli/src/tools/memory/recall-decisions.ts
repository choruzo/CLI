import { z } from 'zod';
import type { ToolContext, ToolDefinition, ToolResult } from '../../agent/types.js';
import { getDecisionMemory } from '../../memory/decision-memory.js';
import { unavailable } from '../optional.js';

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
      // El índice semántico es opcional (embedder ONNX o endpoint HTTP): si no
      // está, la sesión debe seguir. Un tool_error aquí haría que el agente
      // reintente una recuperación que nunca va a funcionar en este entorno.
      return unavailable({
        missing: `semantic memory is not available (${(err as Error).message})`,
        alternatives: [
          'Continue without prior decisions; do not invent what was decided before.',
          'If the answer matters, ask the user or look for it in the repository (STRATUM.md, docs, git log).',
        ],
        howToEnable:
          'install the optional dependencies (@xenova/transformers, better-sqlite3, sqlite-vec) or set memory.embeddingEndpoint.',
      });
    }
  },
};
