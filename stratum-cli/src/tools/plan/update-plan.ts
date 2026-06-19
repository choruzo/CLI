import { z } from 'zod';
import type { ToolDefinition, ToolResult } from '../../agent/types.js';

const schema = z.object({
  stepId: z.string().min(1).describe('Id del paso del plan aprobado (p. ej. "step-3")'),
  status: z
    .enum(['in_progress', 'done', 'skipped'])
    .describe('Nuevo estado del paso'),
});

/**
 * Tool de actualización de estado de paso (Fase 3, modo execute). El ReactLoop
 * la intercepta: aplica el cambio al plan en memoria, emite `plan_step_update`
 * y persiste el plan de forma incremental. `execute` es red de seguridad.
 */
export const updatePlanTool: ToolDefinition = {
  name: 'update_plan',
  description:
    'Marca el progreso de un paso del plan aprobado. Llámala con status "in_progress" antes de empezar un paso, ' +
    '"done" al terminarlo, o "skipped" si resulta innecesario.',
  schema,
  destructive: false,
  serialized: true,

  async execute(): Promise<ToolResult> {
    return {
      ok: false,
      error: 'update_plan solo está disponible durante la ejecución de un plan.',
      recoverable: false,
    };
  },
};
