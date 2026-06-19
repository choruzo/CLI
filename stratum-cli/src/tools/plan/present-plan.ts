import { z } from 'zod';
import type { ToolDefinition, ToolResult } from '../../agent/types.js';

const schema = z.object({
  summary: z.string().min(1).max(200).describe('Una frase describiendo el cambio global'),
  steps: z
    .array(
      z.object({
        title: z.string().min(1).describe('Título corto y accionable del paso'),
        detail: z.string().optional().describe('Detalle opcional del paso'),
      }),
    )
    .min(1)
    .describe('Lista ordenada de pasos concretos y verificables'),
});

/**
 * Tool de cierre de la Fase 1 (modo plan). El ReactLoop la intercepta: cuando el
 * modelo la llama, el loop emite `plan_proposed` y abre el gate de aprobación.
 * `execute` solo se usa como red de seguridad si se invocara fuera del loop.
 */
export const presentPlanTool: ToolDefinition = {
  name: 'present_plan',
  description:
    'Presenta el plan de ejecución propuesto para que el usuario lo apruebe, edite o rechace. ' +
    'Llámala UNA sola vez al terminar la fase de planificación, con un resumen y la lista ordenada de pasos. ' +
    'No escribe nada todavía: la ejecución solo empieza tras la aprobación del usuario.',
  schema,
  destructive: false,
  serialized: true,

  async execute(): Promise<ToolResult> {
    return {
      ok: false,
      error: 'present_plan solo está disponible en modo plan.',
      recoverable: false,
    };
  },
};
