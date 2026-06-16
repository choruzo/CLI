import { z } from 'zod';
import type { ToolContext, ToolDefinition, ToolResult } from '../../agent/types.js';
import { getDecisionMemory } from '../../memory/decision-memory.js';

const schema = z.object({
  title: z.string().max(100).describe('Título breve de la decisión'),
  content: z
    .string()
    .describe('Explicación detallada: contexto, alternativas consideradas, razón de la elección'),
  type: z.enum(['architectural', 'tooling', 'convention', 'bug_fix', 'security', 'user_preference']),
  tags: z.array(z.string()).max(5).describe('Tags para búsqueda semántica'),
  importance: z.enum(['low', 'medium', 'high']),
});

export const storeDecisionTool: ToolDefinition = {
  name: 'store_decision',
  description:
    'Persiste una decisión importante tomada durante esta sesión en la memoria a largo plazo.\n' +
    'Úsala cuando: (1) elijas entre alternativas técnicas significativas, (2) definas convenciones del proyecto, ' +
    '(3) resuelvas un bug no trivial, (4) el usuario te dé una preferencia explícita que debas recordar.\n' +
    'NO la uses para acciones rutinarias o pasos intermedios.',
  schema,
  destructive: false,
  // Escribe en decisions.json + índice vectorial; nunca en paralelo consigo misma.
  serialized: true,

  async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
    const input = schema.parse(params);
    try {
      const memory = getDecisionMemory(ctx.config);
      const result = await memory.save({ ...input, source: 'agent' });
      if (result.deduped) {
        return {
          ok: true,
          output: `Decisión ya registrada (near-duplicado de ${result.duplicateOf}). No se creó una entrada nueva.`,
        };
      }
      return { ok: true, output: `Decisión almacenada: ${result.record.id} — "${result.record.title}"` };
    } catch (err) {
      return {
        ok: false,
        error: `No se pudo almacenar la decisión: ${(err as Error).message}`,
        recoverable: true,
      };
    }
  },
};
