/**
 * M22 — `propose_watch` (PRD de Stratum Dot §23.11, M22 parte 1): el
 * `companion` propone un vigilante y **una persona lo aprueba** antes de que
 * exista. Un vigilante corre solo, sin el LLM, y avisa cuando pasa algo; el
 * agente nunca decide hablar por su cuenta: solo salta lo que la persona aceptó.
 *
 * Es una tool normal con confirmación, no una tool de control del loop: pasa
 * por el mismo `ToolDispatcher` (veto de read-only, `preflight`, confirmación) y
 * por el mismo centro de aprobaciones. *Decidido el 2026-11-19*: confirmación
 * **normal** si solo avisa (lo único que hay en la fase 3) y **forzada** si
 * lanza una rutina (fase 4: entonces `confirmAlways` dependerá de eso).
 *
 * Quien aprueba ve el vigilante **entero** (`describeWatchProposal`): conector,
 * comprobación, argumentos, condición, intervalo y qué hace al saltar. Si no
 * cabe entero en una solicitud, se rechaza antes de preguntar: aprobar es
 * aprobar exactamente eso. Todo se valida contra el catálogo en `preflight`
 * (`defineWatch`), antes de molestar a nadie.
 *
 * Solo la ofrece la sesión principal del `companion` en el daemon (quien la
 * aloja le da `WatchProposals`); una sesión de rutina no propone vigilantes.
 */
import { z } from 'zod';
import type { ToolContext, ToolDefinition, ToolResult } from '../../agent/types.js';
import { WATCH_LIMITS } from '../../protocol/index.js';
import type {
  WatchDefinition,
  WatchDefinitionOutcome,
  WatchRequest,
} from '../../watches/define.js';
import { WatchStoreError } from '../../watches/store.js';

export const PROPOSE_WATCH_TOOL = 'propose_watch';

/**
 * Lo más largo que puede ser lo que ve quien aprueba: deja margen dentro de
 * `INPUT_CHARS` del publicador (2 000), así que la solicitud nunca lo recorta.
 */
export const WATCH_PROPOSAL_DESCRIPTION_MAX = 1_800;

/** Lo que la sesión necesita de quien la aloja para crear un vigilante ya aprobado. */
export interface WatchProposals {
  /** Valida contra el catálogo, sin conectar (`defineWatch` con `origin: 'agent'`). */
  define(request: Omit<WatchRequest, 'origin'>): WatchDefinitionOutcome;
  /** Por qué no se puede crear ahora (almacén en solo lectura, tope), o `null`. */
  blocked(): string | null;
  /** Crea el vigilante. Lanza `WatchStoreError` si no se puede. */
  create(definition: WatchDefinition): { id: string; name: string };
}

const KINDS = ['state-is', 'state-is-not', 'above', 'below', 'changes'] as const;

/**
 * La condición, **plana** para el modelo (un `anyOf` confunde a modelos
 * pequeños); `conditionOf` la convierte en la cerrada del protocolo, que es la
 * que valida `defineWatch`.
 */
const schema = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(WATCH_LIMITS.nameChars)
    .describe('Short name the notice will show, e.g. "WLED down"'),
  connector: z.string().trim().min(1).max(32).describe('Connector id, e.g. "home-assistant"'),
  check: z
    .string()
    .trim()
    .min(1)
    .max(48)
    .describe(
      'The check tool of that connector, by its own name (e.g. "ha_comprobar"), not the mcp__ name',
    ),
  args: z
    .record(z.union([z.string(), z.number(), z.boolean()]))
    .optional()
    .describe('Fixed arguments of the check, exactly as the check tool takes them'),
  condition: z
    .object({
      kind: z
        .enum(KINDS)
        .describe(
          'state-is / state-is-not: the check state is (not) one of `values`; ' +
            'above / below: the check value crosses `threshold`; changes: the state changes',
        ),
      values: z.array(z.string()).optional().describe('For state-is and state-is-not'),
      threshold: z.number().optional().describe('For above and below'),
      forMinutes: z
        .number()
        .int()
        .optional()
        .describe('Only fire if the condition holds at least this many minutes'),
    })
    .describe('When it fires: only when this goes from false to true'),
  intervalSec: z
    .number()
    .int()
    .describe('Seconds between checks; at least the minimum of the check (60 or more)'),
  cooldownMinutes: z
    .number()
    .int()
    .optional()
    .describe(
      `Minimum minutes between two notices (default ${WATCH_LIMITS.defaultCooldownMinutes})`,
    ),
  notifyResolved: z.boolean().optional().describe('Also notify when it goes back to false'),
});

type Input = z.infer<typeof schema>;

/** La condición cerrada: solo los campos de su `kind`. */
function conditionOf(c: Input['condition']): Record<string, unknown> {
  const forMinutes = c.forMinutes !== undefined ? { forMinutes: c.forMinutes } : {};
  switch (c.kind) {
    case 'state-is':
    case 'state-is-not':
      return { kind: c.kind, values: c.values, ...forMinutes };
    case 'above':
    case 'below':
      return { kind: c.kind, threshold: c.threshold, ...forMinutes };
    case 'changes':
      return { kind: c.kind, ...forMinutes };
  }
}

function requestOf(input: Input): Omit<WatchRequest, 'origin'> {
  return {
    name: input.name,
    connector: input.connector,
    check: input.check,
    ...(input.args !== undefined ? { args: input.args } : {}),
    condition: conditionOf(input.condition),
    ...(input.intervalSec !== undefined ? { intervalSec: input.intervalSec } : {}),
    ...(input.cooldownMinutes !== undefined ? { cooldownMinutes: input.cooldownMinutes } : {}),
    ...(input.notifyResolved !== undefined ? { notifyResolved: input.notifyResolved } : {}),
  };
}

function quoted(values: string[]): string {
  return values.map((v) => JSON.stringify(v)).join(' or ');
}

function conditionText(c: WatchDefinition['condition']): string {
  let text: string;
  switch (c.kind) {
    case 'state-is':
      text = `the state is ${quoted(c.values)}`;
      break;
    case 'state-is-not':
      text = `the state is not ${quoted(c.values)}`;
      break;
    case 'above':
      text = `the value goes above ${c.threshold}`;
      break;
    case 'below':
      text = `the value goes below ${c.threshold}`;
      break;
    case 'changes':
      text = 'the state changes';
      break;
  }
  const n = c.forMinutes ?? 0;
  return n > 0 ? `${text} for at least ${n} min` : text;
}

/**
 * Lo que ve quien aprueba: el vigilante **ya validado** (lo que se guardará),
 * entero. Los textos van entre comillas de JSON, que escapa los controles.
 */
export function describeWatchDefinition(d: WatchDefinition): string {
  const args = Object.keys(d.args).length > 0 ? ` with ${JSON.stringify(d.args)}` : '';
  return (
    `${PROPOSE_WATCH_TOOL}: new watch ${JSON.stringify(d.name)} on connector "${d.connector}", ` +
    `check "${d.check}"${args}. It fires when ${conditionText(d.condition)}; checked every ` +
    `${d.intervalSec} s, at most one notice every ${d.cooldownMinutes} min` +
    (d.notifyResolved ? ', and another one when it goes back to normal' : '') +
    '. When it fires it only notifies you (Dot and Telegram); it runs nothing. ' +
    'It keeps checking on its own until you pause or remove it.'
  );
}

/**
 * El vigilante que resulta de la entrada **sin mirar el catálogo**: lo que
 * enseña `describeCall`, que no tiene el catálogo a mano. `preflight` comprueba
 * que es exactamente lo que `defineWatch` validó (si no, veta): lo aprobado es
 * lo que se guarda. Por eso `intervalSec` es obligatorio aquí.
 */
function shownDefinition(input: Input): WatchDefinition {
  return {
    name: input.name,
    connector: input.connector,
    check: input.check,
    args: input.args ?? {},
    condition: conditionOf(input.condition) as WatchDefinition['condition'],
    intervalSec: input.intervalSec,
    cooldownMinutes: input.cooldownMinutes ?? WATCH_LIMITS.defaultCooldownMinutes,
    notifyResolved: input.notifyResolved ?? false,
    origin: 'agent',
  };
}

/** Igualdad de dos definiciones, sin depender del orden de las claves. */
function sameDefinition(a: WatchDefinition, b: WatchDefinition): boolean {
  const canon = (d: WatchDefinition): string =>
    JSON.stringify(d, (_k, v: unknown) =>
      v && typeof v === 'object' && !Array.isArray(v)
        ? Object.fromEntries(Object.entries(v).sort(([x], [y]) => x.localeCompare(y)))
        : v,
    );
  return canon(a) === canon(b);
}

/**
 * La descripción de la llamada (`describeCall`). Tolerante: con una entrada que
 * no valida, la confirmación nunca llega a pedirse (la veta `preflight`), pero
 * `describeCall` no debe lanzar.
 */
export function describeWatchProposal(input: Record<string, unknown>): string {
  const parsed = schema.safeParse(input);
  if (parsed.success) return describeWatchDefinition(shownDefinition(parsed.data));
  const compact = JSON.stringify(input) ?? '';
  return `${PROPOSE_WATCH_TOOL}: ${compact.length > 300 ? compact.slice(0, 297) + '...' : compact}`;
}

/** Valida contra el catálogo y exige que coincida con lo que se enseña. */
function validated(
  proposals: WatchProposals,
  input: Input,
): { ok: true; definition: WatchDefinition } | { ok: false; error: string } {
  const outcome = proposals.define(requestOf(input));
  if (!outcome.ok) return outcome;
  if (!sameDefinition(outcome.definition, shownDefinition(input))) {
    return {
      ok: false,
      error:
        'The watch has text that cannot be shown as is for approval (control or invisible ' +
        'characters, or extra spaces in the name): write it plainly.',
    };
  }
  return outcome;
}

function recoverable(error: string): ToolResult {
  return { ok: false, error, recoverable: true, countsAsFailure: false };
}

export function createProposeWatchTool(proposals: WatchProposals): ToolDefinition {
  return {
    name: PROPOSE_WATCH_TOOL,
    description:
      'Propose a watch: a condition on one of your connector checks that Stratum evaluates on ' +
      'its own, without you, every few minutes; when it becomes true the user gets a notice ' +
      '(Dot and Telegram). The user has to approve it before it exists; if they decline, do ' +
      'not insist. Use it only when the user asks to be told when something happens ("tell me ' +
      'if the WLED goes down"). Only checks declared by a connector work; if the one you name ' +
      'does not exist, the error lists the ones that do. Call the check tool first to see what ' +
      'state and value it returns, so the condition matches them exactly.',
    schema,
    destructive: true,
    serialized: true,
    // Fase 3: solo avisa → confirmación normal. Fase 4: forzada si lanza una rutina.
    preflight(params: unknown): ToolResult | null {
      const parsed = schema.safeParse(params);
      if (!parsed.success) return null; // el dispatcher ya informa del schema
      const blocked = proposals.blocked();
      if (blocked) return recoverable(`The watch cannot be created: ${blocked}`);
      const outcome = validated(proposals, parsed.data);
      if (!outcome.ok) return recoverable(outcome.error);
      // Quien aprueba lo ve entero o no se le pregunta.
      if (describeWatchDefinition(outcome.definition).length > WATCH_PROPOSAL_DESCRIPTION_MAX) {
        return recoverable(
          'The watch is too long to show in full for approval: use a shorter name or arguments.',
        );
      }
      return null;
    },
    async execute(params: unknown, _ctx: ToolContext): Promise<ToolResult> {
      const input = schema.parse(params);
      // Otra vez, por si el catálogo cambió entre la confirmación y ahora.
      const outcome = validated(proposals, input);
      if (!outcome.ok) return recoverable(`The watch was not created: ${outcome.error}`);
      try {
        const watch = proposals.create(outcome.definition);
        return {
          ok: true,
          output:
            `Watch "${watch.name}" created (${watch.id}), approved by the user. ` +
            'Stratum checks it on its own from now on; you will not see its notices.',
        };
      } catch (err) {
        if (err instanceof WatchStoreError) {
          return recoverable(`The watch was not created: ${err.message}`);
        }
        throw err;
      }
    },
  };
}
