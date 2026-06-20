import { z } from 'zod';
import type { ToolDefinition, ToolResult } from '../../agent/types.js';

/** Nombre de la tool de control de delegación (Hito 8A). */
export const DELEGATE_TASK_TOOL = 'delegate_task';

const schema = z.object({
  task: z
    .string()
    .min(1)
    .describe('Self-contained task description. The subagent does NOT see this conversation.'),
  profile: z
    .string()
    .default('general')
    .describe('Name of an agent profile. Resolved and validated at runtime against the loaded profiles.'),
  context: z
    .array(z.string())
    .optional()
    .describe(
      'Paths to files relevant to the task. The subagent reads them itself; they are shared, ' +
        'mutable working files — NOT a read-only snapshot.',
    ),
});

/**
 * Tool de control `delegate_task` (§12.16, Hito 8A). Como present_plan/update_plan,
 * NO se despacha como una tool normal: el ReactLoop la intercepta, instancia un
 * loop hijo aislado, lo ejecuta a término y devuelve el SubagentResult como tool
 * result (inject & recover, §12.3). `execute` es solo red de seguridad si se
 * invocara fuera del loop.
 */
export const delegateTaskTool: ToolDefinition = {
  name: DELEGATE_TASK_TOOL,
  description:
    'Delegate a self-contained subtask to an isolated subagent. The subagent ' +
    'starts with a clean context (only the task description + cwd), runs to completion, ' +
    'and returns a compact structured result. Use for well-scoped work that would bloat ' +
    'this conversation (large-file exploration, focused refactors, research sweeps). ' +
    'Subagents cannot delegate further.',
  schema,
  destructive: false,
  serialized: true,

  async execute(): Promise<ToolResult> {
    return {
      ok: false,
      error: 'delegate_task solo está disponible en el loop principal (no en subagentes).',
      recoverable: false,
    };
  },
};
