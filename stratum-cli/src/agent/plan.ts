/**
 * Hito 7 — Plan & Execute (§12.15 / UI §5.4).
 *
 * Helpers puros del modo plan-and-execute. La filosofía es la misma que cerró
 * el Hito 2.5 para `/init`: no hay pipeline determinista ni agente especializado;
 * es el loop ReAct con el toolset restringido y un tool de cierre (present_plan),
 * análogo a `ExitPlanMode` de Claude Code.
 */
import type { Plan, PlanStep, PlanStepStatus } from './types.js';

/**
 * Allowlist de tools en Fase 1 (planificación, read-only). Cualquier tool fuera
 * de este conjunto (más `present_plan`) se rechaza con un tool_error recuperable
 * mientras el modo es 'plan'. MCP de escritura queda fuera por exclusión.
 */
export const PLAN_ALLOWLIST: ReadonlySet<string> = new Set([
  'read_file',
  'glob',
  'list_directory',
  'grep',
  'web_search',
  'web_fetch',
  'recall_decisions',
]);

/** Nombre de la tool de cierre de Fase 1. */
export const PRESENT_PLAN_TOOL = 'present_plan';
/** Nombre de la tool de actualización de estado de paso (Fase 3). */
export const UPDATE_PLAN_TOOL = 'update_plan';

/**
 * Preámbulo inyectado como mensaje de usuario al entrar en modo plan (Fase 1).
 * `$ARGUMENTS` se sustituye por la tarea del usuario.
 */
export const PLAN_MODE_PROMPT = `You are in PLAN MODE. Do NOT modify anything yet — your only goal in this phase is to produce a concrete, ordered execution plan for the following task:

$ARGUMENTS

Investigate read-only first: use read_file, glob, list_directory, grep, web_search, web_fetch and recall_decisions to understand the codebase and gather the context you need. Writing tools (write_file, edit_file, bash, store_decision, MCP writes) are disabled until the plan is approved — attempting them will fail.

When you have enough understanding, call the \`present_plan\` tool exactly once with:
- \`summary\`: one sentence describing the overall change.
- \`steps\`: an ordered list of concrete, verifiable steps. Each step has a short \`title\` and an optional \`detail\`. Keep steps actionable (e.g. "Add weight field to the provider Zod schema"), not vague ("improve the code"). Prefer 3–8 steps.

Do not write prose explaining the plan — just call \`present_plan\`. The user will approve, edit, or reject it before any execution happens.`;

/** Construye un Plan a partir de la propuesta cruda de present_plan (asigna ids y estado). */
export function makePlanFromProposal(input: {
  summary: string;
  steps: Array<{ title: string; detail?: string }>;
}): Plan {
  return {
    summary: input.summary.trim(),
    steps: input.steps.map((s, i) => ({
      id: `step-${i + 1}`,
      title: s.title.trim(),
      detail: s.detail?.trim() || undefined,
      status: 'pending' as PlanStepStatus,
    })),
  };
}

/**
 * Inyección de ejecución (Fase 3): el plan aprobado se mete en el contexto como
 * checklist de trabajo, instruyendo al modelo a llamar update_plan por paso.
 */
export function buildExecutionInjection(plan: Plan): string {
  const lines = plan.steps.map(
    (s) => `${stepNumber(plan, s.id)}. [${s.id}] ${s.title}${s.detail ? ` — ${s.detail}` : ''}`,
  );
  return `The user APPROVED this plan. Execute it now, step by step.

Plan: ${plan.summary}

${lines.join('\n')}

Rules:
- Before starting a step, call \`update_plan\` with its stepId and status "in_progress".
- When a step is finished, call \`update_plan\` with status "done". If a step turns out to be unnecessary, mark it "skipped".
- Work through the steps in order. You may use any tool now (the read-only restriction is lifted); destructive operations still require user confirmation as usual.
- When all steps are done or skipped, give a brief final summary.`;
}

/**
 * Preámbulo de reanudación (§12.6): cuando se reabre una sesión cuyo plan quedó
 * `in_progress`, se reinyecta el estado de cada paso para que el agente continúe.
 */
export function buildResumePreamble(plan: Plan): string {
  const lines = plan.steps.map((s) => {
    const mark =
      s.status === 'done' ? '[done]' : s.status === 'in_progress' ? '[in progress]' : s.status === 'skipped' ? '[skipped]' : '[pending]';
    return `${stepNumber(plan, s.id)}. ${mark} [${s.id}] ${s.title}${s.detail ? ` — ${s.detail}` : ''}`;
  });
  return `You are resuming an interrupted plan. Plan: ${plan.summary}

${lines.join('\n')}

Resume from where it left off:
- Treat steps marked [done] as already completed.
- A step marked [in progress] may have been applied only partially — re-read the relevant files/state to VERIFY it before marking it done with update_plan.
- Continue with the first step that is not yet done. Call update_plan as you progress.`;
}

/** ¿Está el plan terminado? (todos los pasos done o skipped). */
export function isPlanComplete(plan: Plan): boolean {
  return plan.steps.every((s) => s.status === 'done' || s.status === 'skipped');
}

/** Posición 1-based de un paso por id (para numerar). */
function stepNumber(plan: Plan, id: string): number {
  return plan.steps.findIndex((s) => s.id === id) + 1;
}

// ---------------------------------------------------------------------------
// Serialización markdown ↔ Plan (edición del plan, UI §5.4 Fase 2)
// ---------------------------------------------------------------------------

/**
 * Serializa un plan a markdown editable: una línea por paso. El resumen va como
 * comentario de cabecera; las líneas `- ` son los pasos. `título :: detalle`
 * separa título y detalle opcional. Reordenar/borrar/añadir líneas edita el plan.
 */
export function serializePlanToMarkdown(plan: Plan): string {
  const header = [
    '# Plan',
    `# Summary: ${plan.summary}`,
    '#',
    '# Una línea por paso (empieza con "- "). Usa " :: " para separar título y detalle.',
    '# Reordena, borra o añade líneas libremente. Guarda y cierra para continuar.',
    '',
  ];
  const steps = plan.steps.map((s) => (s.detail ? `- ${s.title} :: ${s.detail}` : `- ${s.title}`));
  return [...header, ...steps, ''].join('\n');
}

/**
 * Re-parsea el markdown editado a un Plan. Reasigna ids secuenciales y pone
 * todos los pasos en `pending` (el usuario es la fuente de verdad del plan
 * aprobado; no se re-explora). El summary se toma de la línea `# Summary:`.
 */
export function parsePlanFromMarkdown(text: string, fallbackSummary = ''): Plan {
  let summary = fallbackSummary;
  const steps: PlanStep[] = [];

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trimEnd();
    const summaryMatch = line.match(/^#\s*Summary:\s*(.*)$/i);
    if (summaryMatch) {
      summary = (summaryMatch[1] ?? '').trim();
      continue;
    }
    if (line.trimStart().startsWith('#')) continue; // comentario
    const stepMatch = line.match(/^\s*(?:[-*]|\d+[.)])\s+(.*)$/);
    if (!stepMatch) continue;
    const body = (stepMatch[1] ?? '').trim();
    if (!body) continue;
    const [title, ...rest] = body.split(' :: ');
    const detail = rest.join(' :: ').trim();
    steps.push({
      id: `step-${steps.length + 1}`,
      title: (title ?? '').trim(),
      detail: detail || undefined,
      status: 'pending',
    });
  }

  return { summary: summary.trim(), steps };
}
