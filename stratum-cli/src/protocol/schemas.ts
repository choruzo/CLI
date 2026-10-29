/**
 * Validación del Stratum Protocol (Zod). Separada de los tipos puros: quien
 * solo necesita el contrato no la importa. Aun así no toca Node — solo `zod` —,
 * así que también vale en un cliente que no sea Node.
 *
 * Dos reglas, según el sentido del dato:
 *  - **Parámetros** (lo que alguien pide): `strict()`. Un campo desconocido
 *    invalida la petición en vez de viajar ignorado hacia el runtime.
 *  - **DTOs, resultados y eventos** (lo que alguien cuenta): se quedan con los
 *    campos conocidos y **descartan** el resto. Un servidor más nuevo puede
 *    añadir campos sin romper a un cliente anterior, y nada que no esté en el
 *    contrato —un `env`, un campo interno— sobrevive a la validación.
 */
import { z } from 'zod';
import { PROTOCOL_ERROR_CODES } from './errors.js';
import type { ClassifiedEvent } from './follow.js';
import {
  HANDOFF_FORMAT,
  HANDOFF_LIMITS,
  type ProtocolAgentMessage,
  type ProtocolHandoffContext,
} from './handoff.js';
import {
  EVENT_CLASS,
  type ProtocolEvent,
  type ProtocolOverviewSnapshot,
  type ProtocolSessionSnapshot,
  type StateEventData,
  type StateEventType,
  type VolatileEventData,
  type VolatileEventType,
} from './events.js';
import {
  METHODS,
  NOTIFICATIONS,
  REVERT_LIMITS,
  type MethodName,
  type MethodParams,
  type MethodResult,
  type NotificationName,
  type NotificationParams,
} from './methods.js';
import type {
  ErrorResponseMessage,
  NotificationMessage,
  RequestMessage,
  SuccessResponseMessage,
} from './messages.js';
import type {
  ProtocolAgent,
  ProtocolSkill,
  ProtocolApproval,
  ProtocolDecision,
  ProtocolJob,
  ProtocolMemoryEvent,
  ProtocolMemoryStatus,
  ProtocolChatMessage,
  ProtocolModel,
  ProtocolPlan,
  ProtocolPlanRequest,
  ProtocolQuestionAnswer,
  ProtocolQuestionRequest,
  ProtocolResolver,
  ProtocolRun,
  ProtocolServerStatus,
  ProtocolSession,
  ProtocolSubagent,
  ProtocolTodo,
  ProtocolToolCall,
  ProtocolContextReport,
  ProtocolHistoryPage,
  ProtocolSessionMemory,
} from './model.js';
import { HISTORY_LIMITS } from './model.js';
import { CAPABILITIES, CLIENT_KINDS, ROLES } from './roles.js';
import { LIMITS } from './version.js';

// ---------------------------------------------------------------------------
// Piezas comunes
// ---------------------------------------------------------------------------

const id = z.string().min(1).max(LIMITS.idChars);
const name = z.string().min(1).max(LIMITS.nameChars);
const timestamp = z.number().finite().nonnegative();
const count = z.number().int().nonnegative();
const seq = z.number().int().nonnegative();
const operationId = id.optional();
const empty = z.object({}).strict();
/** Resultado vacío: tolera campos de más de un servidor más nuevo. */
const emptyResult = z.object({}) as unknown as z.ZodType<Record<string, never>>;

const clientKind = z.enum(CLIENT_KINDS);
const capability = z.enum(CAPABILITIES);
const role = z.enum(ROLES);
const planStepStatus = z.enum(['pending', 'in_progress', 'done', 'skipped']);
const approvalDecision = z.enum(['approve', 'deny', 'allow-all']);

// ---------------------------------------------------------------------------
// Sobre de los mensajes
// ---------------------------------------------------------------------------

const messageId = z.union([z.string().min(1).max(LIMITS.idChars), z.number().finite()]);
const method = z.string().min(1).max(LIMITS.methodChars);

export const requestMessageSchema: z.ZodType<RequestMessage> = z
  .object({ id: messageId, method, params: z.unknown().optional() })
  .strict();

export const notificationMessageSchema: z.ZodType<NotificationMessage> = z
  .object({ method, params: z.unknown().optional() })
  .strict();

export const errorPayloadSchema = z.object({
  code: z.enum(PROTOCOL_ERROR_CODES),
  message: z.string(),
  data: z
    .object({
      protocol: z.number().int().optional(),
      issues: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
      capability: z.string().optional(),
      resolution: z.string().optional(),
      reason: z.string().max(64).optional(),
      limit: z.number().int().optional(),
    })
    .optional(),
});

export const successResponseSchema: z.ZodType<SuccessResponseMessage> = z
  .object({ id: messageId, result: z.unknown() })
  .strict()
  // `result` es obligatorio aunque sea `null`: sin él no es una respuesta.
  .refine((v) => 'result' in v, 'falta result') as z.ZodType<SuccessResponseMessage>;

export const errorResponseSchema: z.ZodType<ErrorResponseMessage> = z
  .object({ id: messageId.nullable(), error: errorPayloadSchema })
  .strict();

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

const environmentRef = z.object({
  name: z.string(),
  tier: z.enum(['production', 'staging', 'development']),
});

const resolver: z.ZodType<ProtocolResolver> = z.object({
  kind: z.enum(['local', 'remote', 'timeout', 'policy']),
  client: clientKind.optional(),
  connectionId: z.number().int().optional(),
  at: z.number().int().nonnegative(),
});
const interactionStatus = z.enum(['resolved', 'expired', 'cancelled']);

export const agentSchema: z.ZodType<ProtocolAgent> = z.object({
  name: z.string(),
  description: z.string(),
  mode: z.enum(['subagent', 'primary', 'all']),
  origin: z.enum(['builtin', 'global', 'project']),
  allowedTools: z.array(z.string()).nullable(),
  provider: z.string().optional(),
  model: z.string().optional(),
});

export const skillSchema: z.ZodType<ProtocolSkill> = z.object({
  name: z.string(),
  description: z.string(),
  scope: z.enum(['builtin', 'user', 'project']),
  presets: z.array(z.enum(['coding', 'assistant'])),
});

export const modelSchema: z.ZodType<ProtocolModel> = z.object({
  provider: z.string(),
  id: z.string(),
  contextWindow: z.number().int().positive().nullable(),
  default: z.boolean().optional(),
});

export const sessionSchema: z.ZodType<ProtocolSession> = z.object({
  id,
  title: z.string(),
  cwd: z.string(),
  host: z.object({ kind: z.enum(['daemon', 'peer']), client: clientKind, connected: z.boolean() }),
  origin: clientKind.optional(),
  state: z.enum(['idle', 'running', 'waiting', 'paused', 'detached', 'closed']),
  agent: z.string(),
  provider: z.string(),
  model: z.string(),
  sessionProfile: z.string(),
  readOnly: z.boolean(),
  activeTarget: z.string(),
  environment: environmentRef.optional(),
  context: z.object({
    used: count,
    max: count,
    pct: z.number().finite().nonnegative(),
    estimated: z.boolean(),
  }),
  tokens: z.object({
    total: count.nullable(),
    status: z.enum(['reported', 'unavailable', 'unsupported']),
  }),
  currentRunId: id.nullable(),
  seq,
  createdAt: timestamp,
  updatedAt: timestamp,
});

export const runSchema: z.ZodType<ProtocolRun> = z.object({
  id,
  sessionId: id,
  kind: z.enum(['run', 'delegate']),
  input: z.string(),
  inputTruncated: z.boolean().optional(),
  mode: z.enum(['normal', 'plan', 'execute']),
  status: z.enum([
    'queued',
    'running',
    'waiting_approval',
    'waiting_input',
    'paused',
    'completed',
    'failed',
    'cancelled',
    'interrupted',
  ]),
  stopReason: z.enum(['stop', 'max_iterations', 'cancelled', 'error', 'budget_tokens']).optional(),
  startedAt: timestamp,
  endedAt: timestamp.optional(),
  counters: z.object({
    llmCalls: count,
    toolCalls: count,
    toolErrors: count,
    blocked: count,
    memoryReads: count,
    memoryWrites: count,
    subagents: count,
    jobs: count,
  }),
  error: z.string().optional(),
});

const toolState = z.enum(['pending', 'running', 'completed', 'error', 'blocked']);

export const toolCallSchema: z.ZodType<ProtocolToolCall> = z.object({
  id,
  runId: id,
  subagentId: id.optional(),
  name: z.string(),
  target: z.string().optional(),
  state: toolState,
  description: z.string(),
  output: z.string().optional(),
  error: z.string().optional(),
  startedAt: timestamp,
  durationMs: z.number().finite().nonnegative().optional(),
});

const messageBase = { id, runId: z.string(), at: timestamp };
const messageText = { text: z.string(), truncated: z.boolean().optional() };

export const messageSchema: z.ZodType<ProtocolChatMessage> = z.discriminatedUnion('kind', [
  z.object({ ...messageBase, kind: z.literal('user'), ...messageText }),
  z.object({ ...messageBase, kind: z.literal('assistant'), ...messageText }),
  z.object({
    ...messageBase,
    kind: z.literal('tool'),
    callId: z.string(),
    name: z.string(),
    description: z.string(),
    target: z.string().optional(),
    state: toolState,
  }),
  z.object({
    ...messageBase,
    kind: z.literal('outcome'),
    status: z.enum(['failed', 'cancelled']),
    text: z.string(),
  }),
]);

export const subagentSchema: z.ZodType<ProtocolSubagent> = z.object({
  id,
  runId: id,
  profile: z.string(),
  task: z.string(),
  status: z.enum(['running', 'completed', 'failed', 'cancelled', 'budget_exceeded', 'interrupted']),
  summary: z.string().optional(),
  filesChanged: z
    .array(z.object({ path: z.string(), action: z.enum(['created', 'modified', 'deleted']) }))
    .optional(),
  iterations: count.optional(),
  durationMs: z.number().finite().nonnegative().optional(),
  error: z.string().optional(),
});

export const decisionSchema: z.ZodType<ProtocolDecision> = z.object({
  id: z.string(),
  title: z.string(),
  type: z.string(),
  tags: z.array(z.string()),
  importance: z.string(),
  timestamp: z.string(),
});

export const memoryEventSchema: z.ZodType<ProtocolMemoryEvent> = z.object({
  kind: z.enum(['read', 'write', 'forget']),
  source: z.enum(['tool', 'auto-extract', 'user']),
  decisions: z.array(z.object({ id: z.string(), title: z.string() })),
  runId: id.optional(),
  at: timestamp,
});

export const jobSchema: z.ZodType<ProtocolJob> = z.object({
  id,
  sessionId: id,
  command: z.string(),
  cwd: z.string(),
  status: z.enum(['running', 'completed', 'failed', 'cancelled']),
  exitCode: z.number().int().nullable().optional(),
  startedAt: timestamp,
  endedAt: timestamp.optional(),
  scope: z.string(),
});

const planStep = z.object({
  id: z.string().min(1).max(LIMITS.idChars),
  title: z.string().max(LIMITS.planStepChars),
  detail: z.string().max(LIMITS.planStepChars).optional(),
  status: planStepStatus,
});

export const planSchema: z.ZodType<ProtocolPlan> = z.object({
  summary: z.string().max(LIMITS.planStepChars),
  steps: z.array(planStep).max(LIMITS.planSteps),
});

export const todoSchema: z.ZodType<ProtocolTodo> = z.object({
  id: z.string(),
  title: z.string(),
  status: planStepStatus,
});

export const approvalSchema: z.ZodType<ProtocolApproval> = z.object({
  id,
  kind: z.enum(['tool', 'host-key']),
  sessionId: id,
  runId: id,
  subagentId: id.optional(),
  tool: z.string(),
  description: z.string(),
  reason: z.string().optional(),
  target: z.string().optional(),
  environment: environmentRef.optional(),
  forced: z.boolean(),
  confirmPhrase: z.string().optional(),
  resolvable: z.enum(['anywhere', 'origin']),
  requestedAt: timestamp,
  expiresAt: timestamp.nullable(),
  status: z.enum(['pending', 'approved', 'denied', 'expired', 'cancelled']),
  decision: approvalDecision.optional(),
  resolvedBy: resolver.optional(),
});

const questionAnswer: z.ZodType<ProtocolQuestionAnswer> = z.object({
  question: z.string().max(LIMITS.answerChars),
  answer: z.string().max(LIMITS.answerChars),
  optionId: id.optional(),
});
const answers = z.array(questionAnswer).max(LIMITS.answers).nullable();

export const questionRequestSchema: z.ZodType<ProtocolQuestionRequest> = z.object({
  id,
  sessionId: id,
  runId: id,
  questions: z.array(
    z.object({
      question: z.string(),
      options: z.array(z.object({ id: z.string(), label: z.string() })).optional(),
      allowCustom: z.boolean().optional(),
    }),
  ),
  requestedAt: timestamp,
  expiresAt: timestamp.nullable(),
});

export const planRequestSchema: z.ZodType<ProtocolPlanRequest> = z.object({
  id,
  sessionId: id,
  runId: id,
  plan: planSchema,
  requestedAt: timestamp,
  expiresAt: timestamp.nullable(),
});

const serverInfo = z.object({ version: z.string(), platform: z.string() });

export const serverStatusSchema: z.ZodType<ProtocolServerStatus> = z.object({
  server: serverInfo,
  protocol: z.number().int(),
  startedAt: timestamp,
  clients: count,
  liveSessions: count,
  activeRuns: count,
  pendingApprovals: count,
});

export const memoryStatusSchema: z.ZodType<ProtocolMemoryStatus> = z.object({
  decisions: count,
  indexed: z.boolean(),
  backend: z.enum(['sqlite-vec', 'fallback', 'none']),
});

// ---------------------------------------------------------------------------
// M11 — conversación guardada, contexto y memoria de sesión
// ---------------------------------------------------------------------------

const memoryItemKind = z.enum([
  'fact',
  'decision',
  'constraint',
  'preference',
  'task',
  'result',
  'entity',
]);

export const historyPageSchema: z.ZodType<ProtocolHistoryPage> = z.object({
  messages: z.array(messageSchema),
  hasMore: z.boolean(),
  total: count,
});

export const contextReportSchema: z.ZodType<ProtocolContextReport> = z.object({
  sessionId: id,
  context: z
    .object({
      window: count,
      reserveOutput: count,
      usableInput: count,
      input: count,
      system: count,
      tools: count,
      globalMemory: count,
      projectMemory: count,
      sessionMemory: count,
      recent: count,
      activeMessages: count,
      estimated: z.boolean(),
      budgets: z.object({
        recent: count,
        sessionMemory: count,
        projectMemory: count,
        globalMemory: count,
        compactAt: z.number().finite(),
        target: z.number().finite(),
      }),
    })
    .nullable(),
  conversation: z
    .object({
      storedMessages: count,
      storedAgentMessages: count,
      activeMessages: count,
      compactions: count,
      lastCompactionAt: timestamp.nullable(),
      lastCompactionError: z.string().nullable(),
      compacting: z.boolean(),
    })
    .nullable(),
  memory: z
    .object({
      enabled: z.boolean(),
      version: count,
      updatedAt: timestamp.nullable(),
      hasSummary: z.boolean(),
      items: z.record(memoryItemKind, count) as unknown as z.ZodType<
        Record<z.infer<typeof memoryItemKind>, number>
      >,
    })
    .nullable(),
});

export const sessionMemorySchema: z.ZodType<ProtocolSessionMemory> = z.object({
  version: count,
  updatedAt: timestamp.nullable(),
  summary: z
    .object({
      text: z.string(),
      sourceCount: count,
      firstSource: z.string().nullable(),
      lastSource: z.string().nullable(),
    })
    .nullable(),
  items: z.array(
    z.object({
      id,
      kind: memoryItemKind,
      key: z.string(),
      text: z.string(),
      status: z.enum(['active', 'superseded', 'done', 'conflict']),
      sources: z.array(z.string()),
      supersedes: z.string().optional(),
      supersededBy: z.string().optional(),
      updatedAt: timestamp,
    }),
  ),
  sourceCursor: z.string().nullable(),
});

// ---------------------------------------------------------------------------
// Eventos y snapshots
// ---------------------------------------------------------------------------

const blockSource = z.enum([
  'preflight',
  'read-only',
  'environment',
  'toolset',
  'plan',
  'steering',
  'plugin',
]);

/** Datos de cada evento de estado. Exportado para poder recorrerlo en los tests. */
export const STATE_EVENT_DATA: { [T in StateEventType]: z.ZodType<StateEventData[T]> } = {
  'session.opened': z.object({ session: sessionSchema }),
  'session.updated': z.object({ session: sessionSchema }),
  'session.closed': z.object({ reason: z.enum(['closed', 'host-exit', 'server-shutdown']) }),
  'run.started': z.object({ run: runSchema }),
  'run.updated': z.object({ run: runSchema }),
  'run.completed': z.object({ run: runSchema }),
  'run.failed': z.object({ run: runSchema }),
  'run.cancelled': z.object({ run: runSchema }),
  'message.completed': z.object({ text: z.string() }),
  'tool.started': z.object({ call: toolCallSchema }),
  'tool.completed': z.object({ call: toolCallSchema }),
  'tool.failed': z.object({ call: toolCallSchema, recoverable: z.boolean() }),
  'tool.blocked': z.object({ call: toolCallSchema, source: blockSource }),
  'subagent.started': z.object({ subagent: subagentSchema }),
  'subagent.completed': z.object({ subagent: subagentSchema }),
  'memory.read': z.object({ memory: memoryEventSchema }),
  'memory.write': z.object({ memory: memoryEventSchema }),
  'context.compressed': z.object({
    tokensBefore: count,
    tokensAfter: count,
    roundsCompressed: count,
  }),
  'todo.updated': z.object({ items: z.array(todoSchema), stale: count }),
  'plan.proposed': z.object({ request: planRequestSchema }),
  'plan.resolved': z.object({
    requestId: id,
    decision: z.enum(['approve', 'reject']),
    plan: planSchema.optional(),
    status: interactionStatus.optional(),
    resolvedBy: resolver.optional(),
  }),
  'plan.step_updated': z.object({ stepId: z.string(), status: planStepStatus }),
  'job.started': z.object({ job: jobSchema }),
  'job.ended': z.object({ job: jobSchema }),
  'steering.queued': z.object({ id, chars: count }),
  'steering.delivered': z.object({ ids: z.array(id), jobs: count }),
  'approval.requested': z.object({ approval: approvalSchema }),
  'approval.resolved': z.object({
    approvalId: id,
    status: z.enum(['approved', 'denied', 'expired', 'cancelled']),
    decision: approvalDecision.optional(),
    resolvedBy: resolver.optional(),
  }),
  'question.requested': z.object({ request: questionRequestSchema }),
  'question.resolved': z.object({
    requestId: id,
    answers,
    status: interactionStatus.optional(),
    resolvedBy: resolver.optional(),
  }),
  warning: z.object({ message: z.string() }),
  error: z.object({ message: z.string(), fatal: z.boolean() }),
};

export const VOLATILE_EVENT_DATA: { [T in VolatileEventType]: z.ZodType<VolatileEventData[T]> } = {
  'message.delta': z.object({ text: z.string() }),
  'reasoning.delta': z.object({ text: z.string() }),
};

const eventBase = z.object({
  sessionId: id,
  at: timestamp,
  runId: id.optional(),
  subagentId: id.optional(),
});

const eventHead = z.object({ type: z.string(), data: z.unknown() });

/**
 * Un evento. Se **reconstruye** con las piezas validadas: el resultado solo
 * tiene los campos del contrato, y un evento de estado con `after` o uno
 * volátil con `seq` no pasa.
 */
export const eventSchema: z.ZodType<ProtocolEvent, z.ZodTypeDef, unknown> = z
  .unknown()
  .transform((value, ctx) => {
    const head = eventHead.safeParse(value);
    const base = eventBase.safeParse(value);
    if (!head.success || !base.success) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'evento mal formado' });
      return z.NEVER;
    }
    const type = head.data.type;
    const cls = Object.prototype.hasOwnProperty.call(EVENT_CLASS, type)
      ? EVENT_CLASS[type as keyof typeof EVENT_CLASS]
      : undefined;
    if (!cls) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `evento desconocido: ${type}` });
      return z.NEVER;
    }
    const raw = value as Record<string, unknown>;
    const dataSchema: z.ZodTypeAny =
      cls === 'state'
        ? STATE_EVENT_DATA[type as StateEventType]
        : VOLATILE_EVENT_DATA[type as VolatileEventType];
    const data = dataSchema.safeParse(head.data.data);
    if (!data.success) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['data'], message: 'data no válido' });
      return z.NEVER;
    }
    const position = z
      .number()
      .int()
      .min(cls === 'state' ? 1 : 0)
      .safeParse(cls === 'state' ? raw.seq : raw.after);
    const foreign = cls === 'state' ? 'after' : 'seq';
    if (!position.success || foreign in raw) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          cls === 'state'
            ? 'un evento de estado lleva seq (≥ 1) y no after'
            : 'un evento volátil lleva after (≥ 0) y no seq',
      });
      return z.NEVER;
    }
    return {
      ...base.data,
      type,
      ...(cls === 'state' ? { seq: position.data } : { after: position.data }),
      data: data.data,
    } as ProtocolEvent;
  });

export const sessionSnapshotSchema: z.ZodType<ProtocolSessionSnapshot> = z.object({
  session: sessionSchema,
  seq,
  run: runSchema.nullable(),
  partial: z.object({ text: z.string(), reasoning: z.string() }),
  toolCalls: z.array(toolCallSchema),
  subagents: z.array(subagentSchema),
  todos: z.array(todoSchema),
  jobs: z.array(jobSchema),
  approvals: z.array(approvalSchema),
  questions: z.array(questionRequestSchema),
  plans: z.array(planRequestSchema),
  messages: z.array(messageSchema),
  messagesTruncated: z.boolean(),
});

export const overviewSnapshotSchema: z.ZodType<ProtocolOverviewSnapshot> = z.object({
  sessions: z.array(sessionSchema),
  approvals: z.array(approvalSchema),
  questions: z.array(questionRequestSchema),
  plans: z.array(planRequestSchema),
});

// ---------------------------------------------------------------------------
// Parámetros (strict) y resultados (tolerantes) de cada método
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Traspaso (M10)
// ---------------------------------------------------------------------------

const agentMessage: z.ZodType<ProtocolAgentMessage> = z
  .object({
    role: z.enum(['system', 'user', 'assistant', 'tool']),
    content: z.string().nullable(),
    toolCalls: z
      .array(
        // Un nombre vacío (un modelo que lo inventó) es historial válido: no impide traspasar.
        z
          .object({
            id: z.string().max(LIMITS.idChars * 4),
            name: z.string().max(LIMITS.nameChars),
            arguments: z.string(),
          })
          .strict(),
      )
      .optional(),
    toolCallId: z
      .string()
      .max(LIMITS.idChars * 4)
      .optional(),
    name: z.string().max(LIMITS.nameChars).optional(),
  })
  .strict();

/**
 * El contexto que entrega un anfitrión par al traspasar su sesión. Es una
 * entrada (alguien la manda): `strict()`, y se valida **entera** al reunir los
 * trozos, antes de montar nada con ella.
 */
export const handoffContextSchema: z.ZodType<ProtocolHandoffContext> = z
  .object({
    format: z.literal(HANDOFF_FORMAT),
    sessionId: id,
    cwd: z.string().min(1).max(LIMITS.pathChars),
    provider: name,
    model: name,
    agent: name.nullable(),
    readOnly: z.boolean(),
    sessionProfile: name,
    planRef: z.string().min(1).max(LIMITS.pathChars).nullable(),
    usage: z
      .object({
        toolCalls: count,
        tokens: count.nullable(),
        tokenStatus: z.enum(['reported', 'unavailable', 'unsupported']),
      })
      .strict(),
    messages: z.array(agentMessage).min(1).max(HANDOFF_LIMITS.maxMessages),
  })
  .strict();

const sessionRef = z.object({ sessionId: id }).strict();
const sessionMutation = z.object({ sessionId: id, operationId }).strict();
const subscriptionRef = z.object({ subscriptionId: id }).strict();
const cwd = z.string().min(1).max(LIMITS.pathChars);
const limit = z.number().int().positive().max(LIMITS.listLimit);
const steerStatus = z.enum(['accepted', 'not-accepting', 'empty', 'too-large']);
const cancelResult = z.object({ status: z.enum(['cancelled', 'not-running']) });
const pauseResult = z.object({
  status: z.enum(['requested', 'already-requested', 'already-paused', 'not-running']),
});
const resumeResult = z.object({ status: z.enum(['resumed', 'not-paused', 'not-running']) });
const runMutation = z.object({ sessionId: id, runId: id.optional(), operationId }).strict();
const runRef = z.object({ sessionId: id, runId: id.optional() }).strict();
const sessionResult = z.object({ session: sessionSchema });
const revertPaths = z.array(z.string().max(LIMITS.pathChars)).max(REVERT_LIMITS.paths);
const revertPlanSchema = z.object({
  turns: z.array(z.number().int().positive()).max(REVERT_LIMITS.turns),
  restore: revertPaths,
  remove: revertPaths,
  conflicts: revertPaths,
  skipped: revertPaths,
  truncated: z.boolean(),
});
const runResult = z.object({ run: runSchema });

const scope = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('overview') }).strict(),
  z
    .object({
      kind: z.literal('session'),
      sessionId: id,
      sinceSeq: seq.optional(),
      volatile: z.boolean().optional(),
    })
    .strict(),
]);

export const PARAMS: { [M in MethodName]: z.ZodType<MethodParams<M>, z.ZodTypeDef, unknown> } = {
  'core.hello': z
    .object({
      protocol: z.number().int().positive(),
      token: z.string().min(1).max(LIMITS.tokenChars),
      client: z.object({ kind: clientKind, name, version: name }).strict(),
      roles: z.array(role).min(1).max(ROLES.length),
      features: z.array(name).max(64).optional(),
      approverKey: z.string().min(1).max(LIMITS.approverKeyChars).optional(),
    })
    .strict(),
  'core.status': empty,
  'core.shutdown': z.object({ force: z.boolean().optional(), operationId }).strict(),

  'agents.list': z.object({ cwd: cwd.optional() }).strict(),
  'skills.list': z.object({ cwd: cwd.optional(), agent: name.optional() }).strict(),
  'models.list': z.object({ provider: name.optional() }).strict(),

  'sessions.list': z.object({ live: z.boolean().optional(), limit: limit.optional() }).strict(),
  'sessions.get': sessionRef,
  'sessions.history': z
    .object({
      sessionId: id,
      before: id.optional(),
      limit: z.number().int().positive().max(HISTORY_LIMITS.pageMessages).optional(),
    })
    .strict(),
  'sessions.context': sessionRef,
  'sessions.memory': sessionRef,
  'sessions.open': z
    .object({
      cwd: cwd.optional(),
      // Reservado y de solo entrada: ver `SessionsOpenParams.env`.
      env: z
        .record(z.string().max(LIMITS.nameChars), z.string().max(LIMITS.envValueChars))
        .refine((v) => Object.keys(v).length <= LIMITS.envVars, 'demasiadas variables')
        .optional(),
      resume: id.optional(),
      agent: name.optional(),
      provider: name.optional(),
      model: name.optional(),
      readOnly: z.boolean().optional(),
      sessionProfile: name.optional(),
      operationId,
    })
    .strict(),
  'sessions.close': sessionMutation,
  'sessions.setModel': z
    .object({ sessionId: id, model: name, provider: name.optional(), operationId })
    .strict(),
  'sessions.setAgent': z.object({ sessionId: id, agent: name.nullable(), operationId }).strict(),
  'sessions.setReadOnly': z.object({ sessionId: id, readOnly: z.boolean(), operationId }).strict(),
  'sessions.detach': sessionMutation,
  'sessions.revert': z
    .object({
      sessionId: id,
      turns: z.number().int().positive().max(REVERT_LIMITS.turns).optional(),
      dryRun: z.boolean().optional(),
      force: z.boolean().optional(),
      operationId,
    })
    .strict(),

  'runs.list': z
    .object({ sessionId: id.optional(), active: z.boolean().optional(), limit: limit.optional() })
    .strict(),
  'runs.get': z.object({ runId: id }).strict(),
  'runs.start': z
    .object({
      sessionId: id,
      input: z.string().min(1).max(LIMITS.inputChars),
      mode: z.enum(['normal', 'plan']).optional(),
      operationId,
    })
    .strict(),
  'runs.steer': z
    .object({ sessionId: id, text: z.string().max(LIMITS.inputChars), operationId })
    .strict(),
  'runs.pause': runMutation,
  'runs.resume': runMutation,
  'runs.cancel': runMutation,

  'approvals.list': z.object({ sessionId: id.optional() }).strict(),
  'approvals.resolve': z
    .object({
      sessionId: id.optional(),
      approvalId: id,
      decision: approvalDecision,
      phrase: z.string().max(LIMITS.phraseChars).optional(),
      operationId,
    })
    .strict(),
  'questions.answer': z
    .object({ sessionId: id.optional(), requestId: id, answers, operationId })
    .strict(),
  'plans.decide': z
    .object({
      sessionId: id.optional(),
      requestId: id,
      decision: z.enum(['approve', 'reject']),
      plan: planSchema.optional(),
      operationId,
    })
    .strict(),

  'jobs.list': sessionRef,
  'jobs.cancel': z.object({ sessionId: id, jobId: id, operationId }).strict(),

  'memory.status': z.object({ cwd: cwd.optional() }).strict(),
  'memory.decisions': z
    .object({
      cwd: cwd.optional(),
      query: z.string().max(LIMITS.queryChars).optional(),
      limit: limit.optional(),
    })
    .strict(),

  'events.subscribe': z.object({ scope }).strict(),
  'events.unsubscribe': subscriptionRef,
  'trace.subscribe': sessionRef,
  'trace.unsubscribe': subscriptionRef,

  'host.register': z
    .object({
      snapshot: sessionSnapshotSchema,
      pid: z.number().int().positive().optional(),
      claim: z.string().min(16).max(128).optional(),
      operationId,
    })
    .strict(),
  'host.publish': z
    .object({
      sessionId: id,
      epoch: z.number().int().positive(),
      snapshot: sessionSnapshotSchema.optional(),
      events: z.array(eventSchema).max(LIMITS.publishBatch),
    })
    .strict()
    .refine((p) => p.snapshot !== undefined || p.events.length > 0, {
      message: 'events or snapshot required',
      path: ['events'],
    }),
  'host.unregister': sessionMutation,
  'host.handoffBegin': z
    .object({
      sessionId: id,
      epoch: z.number().int().positive(),
      seq,
      format: z.literal(HANDOFF_FORMAT),
      chunks: z.number().int().positive().max(HANDOFF_LIMITS.maxChunks),
      chars: z.number().int().positive().max(HANDOFF_LIMITS.maxChars),
      operationId,
    })
    .strict(),
  'host.handoffChunk': z
    .object({
      sessionId: id,
      handoffId: id,
      index: z
        .number()
        .int()
        .nonnegative()
        .max(HANDOFF_LIMITS.maxChunks - 1),
      data: z.string().min(1).max(HANDOFF_LIMITS.chunkChars),
    })
    .strict(),
  'host.handoffCommit': z.object({ sessionId: id, handoffId: id }).strict(),
  'host.handoffAbort': z.object({ sessionId: id, handoffId: id }).strict(),

  'host.cancel': runRef,
  'host.pause': runRef,
  'host.resume': runRef,
  'host.steer': z.object({ sessionId: id, text: z.string().max(LIMITS.inputChars) }).strict(),
  'host.resolveApproval': z
    .object({
      sessionId: id,
      approvalId: id,
      decision: approvalDecision,
      phrase: z.string().max(LIMITS.phraseChars).optional(),
      by: resolver,
    })
    .strict(),
  'host.answerQuestions': z
    .object({ sessionId: id, requestId: id, answers, by: resolver })
    .strict(),
  'host.decidePlan': z
    .object({
      sessionId: id,
      requestId: id,
      decision: z.enum(['approve', 'reject']),
      plan: planSchema.optional(),
      by: resolver,
    })
    .strict(),
  'host.detach': sessionRef,
};

export const RESULTS: { [M in MethodName]: z.ZodType<MethodResult<M>, z.ZodTypeDef, unknown> } = {
  'core.hello': z.object({
    protocol: z.number().int().positive(),
    server: serverInfo,
    connectionId: z.number().int(),
    capabilities: z.array(capability),
    features: z.array(z.string()),
  }),
  'core.status': serverStatusSchema,
  'core.shutdown': emptyResult,

  'agents.list': z.object({ agents: z.array(agentSchema) }),
  'skills.list': z.object({ skills: z.array(skillSchema) }),
  'models.list': z.object({ models: z.array(modelSchema), error: z.string().optional() }),

  'sessions.list': z.object({ sessions: z.array(sessionSchema) }),
  'sessions.get': z.object({ snapshot: sessionSnapshotSchema }),
  'sessions.history': historyPageSchema,
  'sessions.context': z.object({ report: contextReportSchema }),
  'sessions.memory': z.object({ memory: sessionMemorySchema }),
  'sessions.open': sessionResult,
  'sessions.close': emptyResult,
  'sessions.setModel': sessionResult,
  'sessions.setAgent': sessionResult,
  'sessions.setReadOnly': sessionResult,
  'sessions.detach': z.object({
    status: z.enum(['detached', 'already-daemon']),
    session: sessionSchema,
  }),
  'sessions.revert': z.object({
    status: z.enum(['planned', 'reverted', 'conflicts', 'nothing', 'failed']),
    plan: revertPlanSchema.nullable(),
  }),

  'runs.list': z.object({ runs: z.array(runSchema) }),
  'runs.get': runResult,
  'runs.start': runResult,
  'runs.steer': z.object({ status: steerStatus }),
  'runs.pause': pauseResult,
  'runs.resume': resumeResult,
  'runs.cancel': cancelResult,

  'approvals.list': z.object({
    approvals: z.array(approvalSchema),
    questions: z.array(questionRequestSchema),
    plans: z.array(planRequestSchema),
  }),
  'approvals.resolve': emptyResult,
  'questions.answer': emptyResult,
  'plans.decide': emptyResult,

  'jobs.list': z.object({ jobs: z.array(jobSchema) }),
  'jobs.cancel': emptyResult,

  'memory.status': memoryStatusSchema,
  'memory.decisions': z.object({ decisions: z.array(decisionSchema) }),

  'events.subscribe': z.object({ subscriptionId: id, mode: z.enum(['replay', 'snapshot']) }),
  'events.unsubscribe': emptyResult,
  'trace.subscribe': z.object({ subscriptionId: id }),
  'trace.unsubscribe': emptyResult,

  'host.register': z.object({
    claim: z.string().min(16).max(128),
    epoch: z.number().int().positive(),
  }),
  'host.publish': emptyResult,
  'host.unregister': emptyResult,
  'host.handoffBegin': z.object({ handoffId: id }),
  'host.handoffChunk': emptyResult,
  'host.handoffCommit': z.object({ session: sessionSchema, epoch: z.number().int().positive() }),
  'host.handoffAbort': emptyResult,

  'host.cancel': cancelResult,
  'host.pause': pauseResult,
  'host.resume': resumeResult,
  'host.steer': z.object({ status: steerStatus }),
  'host.resolveApproval': emptyResult,
  'host.answerQuestions': emptyResult,
  'host.decidePlan': emptyResult,
  'host.detach': z.object({ status: z.literal('detached') }),
};

export const NOTIFICATION_PARAMS: {
  [N in NotificationName]: z.ZodType<NotificationParams<N>, z.ZodTypeDef, unknown>;
} = {
  events: z.object({ subscriptionId: id, events: z.array(eventSchema) }),
  snapshot: z.object({ subscriptionId: id, snapshot: sessionSnapshotSchema }),
  overview: z.object({ subscriptionId: id, overview: overviewSnapshotSchema }),
  'trace.records': z.object({
    subscriptionId: id,
    sessionId: id,
    reset: z.boolean(),
    format: z.number().int(),
    records: z.array(z.record(z.unknown())),
  }),
  goodbye: z.object({ reason: z.enum(['shutdown', 'replaced', 'protocol-error', 'idle']) }),
};

/** Las tablas cubren exactamente los métodos y notificaciones del contrato. */
export const SCHEMA_COVERAGE = {
  methods: Object.keys(METHODS) as MethodName[],
  notifications: [...NOTIFICATIONS],
};

// --- clientes: de JSON sin tipar a lo que entienden `follow.ts`/`overview.ts` (M12)

/** Una foto de sesión validada, o `null` si no cumple el contrato. */
export function parseSessionSnapshot(raw: unknown): ProtocolSessionSnapshot | null {
  const parsed = sessionSnapshotSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** Una foto de conjunto validada, o `null` si no cumple el contrato. */
export function parseOverviewSnapshot(raw: unknown): ProtocolOverviewSnapshot | null {
  const parsed = overviewSnapshotSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Clasifica un evento recibido sin tipar (`followSession` decide qué hacer con
 * cada clase). Un tipo de estado desconocido con `seq` no es inválido: un
 * daemon más nuevo puede añadir eventos dentro de la v1.
 */
export function classifyEvent(raw: unknown): ClassifiedEvent {
  const parsed = eventSchema.safeParse(raw);
  if (parsed.success) return { kind: 'event', event: parsed.data };
  if (!isPlainRecord(raw) || typeof raw.type !== 'string') return { kind: 'invalid' };
  if (Object.prototype.hasOwnProperty.call(EVENT_CLASS, raw.type)) return { kind: 'invalid' };
  const { seq, at, sessionId } = raw;
  if (typeof sessionId !== 'string') return { kind: 'invalid' };
  if (typeof seq === 'number' && Number.isInteger(seq) && seq >= 1 && !('after' in raw)) {
    return { kind: 'unknown-state', sessionId, seq, at: typeof at === 'number' ? at : 0 };
  }
  return 'after' in raw ? { kind: 'skip' } : { kind: 'invalid' };
}
