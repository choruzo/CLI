import { z } from 'zod';
import type { ToolDefinition, ToolResult } from '../agent/types.js';

/** Nombre de la tool de control de la lista de tareas (Hito 11). */
export const TODO_TOOL = 'todo';

const itemSchema = z.object({
  id: z
    .string()
    .optional()
    .describe('Id of an existing task. Keep it to preserve identity when rewriting the list.'),
  title: z.string().min(1).describe('Short, actionable task title'),
  status: z
    .enum(['pending', 'in_progress', 'done', 'skipped'])
    .optional()
    .describe('Task status (default: pending)'),
});

const schema = z.object({
  action: z
    .enum(['write', 'add', 'update', 'clear', 'list'])
    .describe(
      'write: replace the whole list · add: append tasks · update: change one task · ' +
        'clear: empty the list · list: read it back without changing anything',
    ),
  items: z
    .array(itemSchema)
    .optional()
    .describe('Tasks for write (the complete list) or add (only the new ones)'),
  id: z.string().optional().describe('Task id to change (update only)'),
  title: z.string().optional().describe('New title for the task (update only, optional)'),
  status: z
    .enum(['pending', 'in_progress', 'done', 'skipped'])
    .optional()
    .describe('New status for the task (update only)'),
});

/**
 * Tool de control interceptada por el `ReactLoop` (como `present_plan` o
 * `question`): nunca llega al dispatcher. `execute` es solo red de seguridad.
 *
 * Las guidelines de la descripción son la parte que de verdad hace que funcione
 * con modelos pequeños; están adaptadas de gentle-pi (Alan Buscaglia, MIT).
 */
export const todoTool: ToolDefinition = {
  name: TODO_TOOL,
  description:
    'Track a short list of tasks for the work in progress. The open tasks are re-injected into ' +
    'your context every turn, so this is your working memory for multi-step work.\n' +
    '- Use todo for work with three or more steps, or when the user hands you a list. ' +
    'Skip it for single trivial requests.\n' +
    '- Mark a task in_progress before starting it and done right after finishing it; ' +
    'keep exactly one task in_progress.\n' +
    '- Prefer write with the complete list whenever the plan changes; keep the ids of tasks ' +
    'that already exist.\n' +
    '- Never mark a task done while tests fail or the work is partial; add a task for the ' +
    'blocker instead.\n' +
    'For a large change that needs the user to approve a plan first, use plan mode instead.',
  schema,
  destructive: false,
  serialized: true,

  async execute(): Promise<ToolResult> {
    return {
      ok: false,
      error: 'todo solo está disponible dentro del loop del agente.',
      recoverable: false,
    };
  },
};
