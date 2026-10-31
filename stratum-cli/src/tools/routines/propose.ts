/**
 * M16 — `propose_routine` (PRD de Stratum Dot §23.5): el `companion` propone
 * una rutina y **una persona la aprueba** antes de que exista. Una rutina es
 * trabajo autónomo futuro: correrá sin nadie mirando, así que no hay política
 * que la cree sola.
 *
 * Es una tool normal con confirmación forzada (`confirmAlways`), no una tool de
 * control del loop: pasa por el mismo `ToolDispatcher` (veto de read-only,
 * `preflight`, confirmación) y por el mismo centro de aprobaciones, con la
 * confirmación nativa de Dot. Forzada significa que ni el allow-all de sesión
 * ni `tools.confirmDestructive: false` la saltan, y que sin nadie que conteste
 * se bloquea; en el daemon, lo pendiente caduca a la respuesta negativa.
 *
 * La descripción que ve quien aprueba lleva el prompt **entero** (por eso su
 * tope deja sitio dentro del de una solicitud): aprobar es aprobar exactamente
 * eso. Solo la ofrece la sesión principal del `companion` en el daemon (quien
 * la aloja le da `RoutineProposals`); una sesión de rutina no propone rutinas.
 */
import { z } from 'zod';
import type { ToolContext, ToolDefinition, ToolResult } from '../../agent/types.js';
import { parseSchedule } from '../../routines/schedule.js';
import { RoutineStoreError } from '../../routines/store.js';

export const PROPOSE_ROUTINE_TOOL = 'propose_routine';

/**
 * Topes de lo propuesto: con nombre, horario y límites, la descripción entera
 * cabe en una solicitud (`INPUT_CHARS` del publicador, 2 000), así que quien
 * aprueba nunca ve el prompt recortado. Lo fija `propose.test.ts`.
 */
export const PROPOSED_PROMPT_MAX_CHARS = 1_600;
export const PROPOSED_SCHEDULE_MAX_CHARS = 100;

export interface RoutineProposal {
  name: string;
  schedule: string;
  prompt: string;
  limits?: { maxIterations?: number; timeoutMinutes?: number };
}

/** Lo que la sesión necesita de quien la aloja para crear una rutina ya aprobada. */
export interface RoutineProposals {
  /** Crea la rutina (`origin: 'agent'`). Lanza `RoutineStoreError` si no vale. */
  create(proposal: RoutineProposal): { id: string; name: string; nextFireAt: number | null };
}

const schema = z.object({
  name: z.string().trim().min(1).max(80).describe('Short name for the routine, unique'),
  schedule: z
    .string()
    .trim()
    .min(1)
    .max(PROPOSED_SCHEDULE_MAX_CHARS)
    .describe(
      'When it runs, in local time: an interval ("30m", "2h", "1d") or a 5-field cron ' +
        'expression ("0 9 * * 1-5" = weekdays at 9:00)',
    ),
  prompt: z
    .string()
    .trim()
    .min(1)
    .max(PROPOSED_PROMPT_MAX_CHARS)
    .describe(
      'The instruction you will receive each time it runs, self-contained: you will not ' +
        'remember this conversation when it runs',
    ),
  maxIterations: z.number().int().min(1).max(200).optional(),
  timeoutMinutes: z.number().int().min(1).max(1440).optional(),
});

type Input = z.infer<typeof schema>;

function proposalOf(input: Input): RoutineProposal {
  const limits = {
    ...(input.maxIterations ? { maxIterations: input.maxIterations } : {}),
    ...(input.timeoutMinutes ? { timeoutMinutes: input.timeoutMinutes } : {}),
  };
  return {
    name: input.name,
    schedule: input.schedule,
    prompt: input.prompt,
    ...(Object.keys(limits).length > 0 ? { limits } : {}),
  };
}

/**
 * Lo que ve quien aprueba (`describeCall`): nombre, horario, límites y el
 * prompt completo. Tolerante con una entrada que no valida (la confirmación
 * nunca llega a pedirse, pero `describeCall` no debe lanzar).
 */
export function describeRoutineProposal(input: Record<string, unknown>): string {
  const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
  const limits = [
    typeof input.maxIterations === 'number' ? `at most ${input.maxIterations} iterations` : '',
    typeof input.timeoutMinutes === 'number' ? `timeout ${input.timeoutMinutes} min` : '',
  ].filter(Boolean);
  return (
    `${PROPOSE_ROUTINE_TOOL}: new routine "${text(input.name)}", schedule "${text(input.schedule)}"` +
    (limits.length > 0 ? ` (${limits.join(', ')})` : '') +
    `. It will run on its own, with nobody watching, with this prompt: ${text(input.prompt)}`
  );
}

function recoverable(error: string): ToolResult {
  return { ok: false, error, recoverable: true, countsAsFailure: false };
}

export function createProposeRoutineTool(proposals: RoutineProposals): ToolDefinition {
  return {
    name: PROPOSE_ROUTINE_TOOL,
    description:
      'Propose a routine: a task you will run on your own on a schedule (in its own session, ' +
      'with your box and your memory), with nobody watching. The user has to approve it before ' +
      'it exists; if they decline, do not insist. Use it only when the user asks for something ' +
      'recurring ("every morning…", "check X every hour"). The prompt must be self-contained.',
    schema,
    destructive: true,
    serialized: true,
    // Trabajo autónomo futuro: una persona lo aprueba cada vez, sin allow-all.
    confirmAlways: () => true,
    // Un horario que no vale se dice antes de preguntar a nadie.
    preflight(params: unknown): ToolResult | null {
      const parsed = schema.safeParse(params);
      if (!parsed.success) return null; // el dispatcher ya informa del schema
      const s = parseSchedule(parsed.data.schedule);
      return s.ok ? null : recoverable(s.error);
    },
    async execute(params: unknown, _ctx: ToolContext): Promise<ToolResult> {
      const input = schema.parse(params);
      try {
        const routine = proposals.create(proposalOf(input));
        const next =
          routine.nextFireAt !== null
            ? ` Its next run is at ${new Date(routine.nextFireAt).toISOString()}.`
            : '';
        return {
          ok: true,
          output: `Routine "${routine.name}" created (${routine.id}), approved by the user.${next}`,
        };
      } catch (err) {
        if (err instanceof RoutineStoreError) {
          return recoverable(`The routine was not created: ${err.message}`);
        }
        throw err;
      }
    },
  };
}
