import { z } from 'zod';
import type { StratumConfig } from '../config/schema.js';
import type { ToolDefinition, ToolResult } from '../agent/types.js';
import type { ToolRegistry } from './registry.js';

/** Nombre de la tool de control de evidencia TDD (Hito 13). */
export const TEST_EVIDENCE_TOOL = 'test_evidence';

const schema = z.object({
  action: z
    .enum(['record', 'list'])
    .describe('record: register one phase of the cycle · list: read the evidence back'),
  task: z
    .string()
    .optional()
    .describe('The unit of work this evidence belongs to. Use the same wording for every phase.'),
  phase: z
    .enum(['safety_net', 'red', 'green', 'triangulate', 'refactor'])
    .optional()
    .describe(
      'safety_net: baseline of the existing tests before touching the file · ' +
        'red: the new test fails · green: it passes with the implementation · ' +
        'triangulate: a second case with different inputs · refactor: cleanup, still green',
    ),
  command: z.string().optional().describe('The test command you ran (the relevant file only)'),
  outcome: z.enum(['pass', 'fail']).optional().describe('Result of that run'),
  evidence: z
    .string()
    .optional()
    .describe('What you observed: "5 passing", "1 failing: expected 3, got undefined"…'),
  skipReason: z
    .string()
    .optional()
    .describe('Only for triangulate: why a second case does not apply here'),
});

/**
 * Tool de control interceptada por el `ReactLoop` (como `todo` o `present_plan`):
 * nunca llega al dispatcher. `execute` es solo red de seguridad.
 *
 * Solo se registra cuando la config declara `tools.testCommand`: sin un comando
 * de tests que correr, exigir evidencia sería pedirle al modelo que invente.
 */
export const testEvidenceTool: ToolDefinition = {
  name: TEST_EVIDENCE_TOOL,
  description:
    'Record evidence for each phase of the TDD cycle: SAFETY NET → RED → GREEN → TRIANGULATE → ' +
    'REFACTOR. Call it as each phase actually happens; evidence written afterwards is not evidence.\n' +
    '- SAFETY NET: before editing an existing file, run its tests and record the baseline. ' +
    'If something already fails, STOP and report it as a pre-existing failure — do not fix it.\n' +
    '- RED: the new test must fail. A test that passes before you write the code is not a RED.\n' +
    '- GREEN: it passes now. Check it is not a false green: 0 tests run, a loop that iterated ' +
    'zero times, or a setup that never triggers the code path are not GREEN.\n' +
    '- TRIANGULATE: add a second case with different inputs. One case lets a hardcoded return ' +
    'pass; skipping it needs an explicit skipReason.\n' +
    '- REFACTOR: clean up with the tests still green.\n' +
    'Run only the relevant test file during the cycle; the full suite belongs at the end.',
  schema,
  destructive: false,
  serialized: true,

  async execute(): Promise<ToolResult> {
    return {
      ok: false,
      error: 'test_evidence solo está disponible dentro del loop del agente.',
      recoverable: false,
    };
  },
};

/**
 * Registra la tool solo si hay un comando de tests configurado (§ mismo criterio
 * que las tools SSH con su inventario: sin el recurso, el LLM no la ve).
 */
export function registerTddTools(registry: ToolRegistry, config: StratumConfig): void {
  if (!config.tools.testCommand) return;
  registry.register(testEvidenceTool);
}
