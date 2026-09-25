import type {
  AgentEvent,
  QuestionAnswer,
  QuestionItem,
  TodoItem,
} from '../../../stratum-cli/src/agent/events';
import type {
  ConfigApplied,
  ConfigIssue,
  ConfigSnapshot,
  ConversationStats,
  ConversationSummary,
  DecisionSummary,
  DesktopOsPrefs,
  TranscriptPart,
  TranscriptToolCall,
  TranscriptTurn,
  WorkspaceFileInfo,
  WorkspaceStatus,
} from '../../../stratum-cli/src/desktop/protocol';
import { DEFAULT_GLOBAL_HOTKEY } from '../../../stratum-cli/src/config/accelerator';

/**
 * Validación estructural de lo que llega del sidecar antes de entrar al estado
 * de la UI. Rust reenvía el JSON tal cual; aquí se comprueba cada variante que
 * la UI usa, campo a campo. Lo que no encaja se descarta: una trama mal formada
 * no puede tumbar el render (p. ej. un `todo_updated` cuyo `items` no es un
 * array). Devuelve un objeto nuevo con solo los campos conocidos.
 */

const str = (v: unknown): v is string => typeof v === 'string';
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const bool = (v: unknown): v is boolean => typeof v === 'boolean';
export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const TODO_STATUS = new Set(['pending', 'in_progress', 'done', 'skipped']);
const STOP_REASONS = new Set(['stop', 'max_iterations', 'cancelled', 'error', 'budget_tokens']);

export function todoItem(v: unknown): TodoItem | null {
  if (!isRecord(v) || !str(v.id) || !str(v.title) || !str(v.status)) return null;
  if (!TODO_STATUS.has(v.status)) return null;
  return { id: v.id, title: v.title, status: v.status as TodoItem['status'] };
}

export function questionItem(v: unknown): QuestionItem | null {
  if (!isRecord(v) || !str(v.question)) return null;
  const q: QuestionItem = { question: v.question };
  if (v.options !== undefined) {
    if (!Array.isArray(v.options)) return null;
    const options = v.options.map((o) =>
      isRecord(o) && str(o.id) && str(o.label) ? { id: o.id, label: o.label } : null,
    );
    if (options.some((o) => o === null)) return null;
    q.options = options as QuestionItem['options'];
  }
  if (v.allowCustom !== undefined) {
    if (!bool(v.allowCustom)) return null;
    q.allowCustom = v.allowCustom;
  }
  return q;
}

function questionAnswer(v: unknown): QuestionAnswer | null {
  if (!isRecord(v) || !str(v.question) || !str(v.answer)) return null;
  if (v.optionId !== undefined && !str(v.optionId)) return null;
  return {
    question: v.question,
    answer: v.answer,
    ...(v.optionId !== undefined ? { optionId: v.optionId as string } : {}),
  };
}

function all<T>(list: unknown, item: (v: unknown) => T | null): T[] | null {
  if (!Array.isArray(list)) return null;
  const out = list.map(item);
  return out.some((x) => x === null) ? null : (out as T[]);
}

/**
 * Valida un `AgentEvent`. Solo se aceptan las variantes que la UI de D1 usa;
 * el resto (subagentes, plan, compresión…) no aparece en el modo Chat y se
 * descarta.
 */
export function agentEvent(v: unknown): AgentEvent | null {
  if (!isRecord(v) || !str(v.type)) return null;
  switch (v.type) {
    case 'text_delta':
      return str(v.delta) ? { type: 'text_delta', delta: v.delta } : null;
    case 'thinking':
      // D7: razonamiento del modelo (`reasoning_content`).
      return str(v.text) ? { type: 'thinking', text: v.text } : null;
    case 'tool_call_start':
      return str(v.id) && str(v.name) && str(v.input_so_far)
        ? { type: 'tool_call_start', id: v.id, name: v.name, input_so_far: v.input_so_far }
        : null;
    case 'tool_call_ready':
      return str(v.id) && str(v.name) && isRecord(v.input)
        ? { type: 'tool_call_ready', id: v.id, name: v.name, input: v.input }
        : null;
    case 'tool_result':
      return str(v.id) && str(v.name) && str(v.result) && num(v.durationMs)
        ? { type: 'tool_result', id: v.id, name: v.name, result: v.result, durationMs: v.durationMs }
        : null;
    case 'tool_error':
      return str(v.id) && str(v.name) && str(v.error) && bool(v.recoverable)
        ? { type: 'tool_error', id: v.id, name: v.name, error: v.error, recoverable: v.recoverable }
        : null;
    case 'warning':
      return str(v.message) ? { type: 'warning', message: v.message } : null;
    case 'error':
      return str(v.message) && bool(v.fatal)
        ? { type: 'error', message: v.message, fatal: v.fatal }
        : null;
    case 'done':
      return str(v.stopReason) && STOP_REASONS.has(v.stopReason)
        ? { type: 'done', stopReason: v.stopReason as 'stop' }
        : null;
    case 'todo_updated': {
      const items = all(v.items, todoItem);
      return items && num(v.stale) ? { type: 'todo_updated', items, stale: v.stale } : null;
    }
    case 'questions_asked': {
      const questions = all(v.questions, questionItem);
      return questions ? { type: 'questions_asked', questions } : null;
    }
    case 'questions_answered': {
      if (v.answers === null) return { type: 'questions_answered', answers: null };
      const answers = all(v.answers, questionAnswer);
      return answers ? { type: 'questions_answered', answers } : null;
    }
    default:
      return null;
  }
}

export function questionItems(v: unknown): QuestionItem[] | null {
  return all(v, questionItem);
}

export function isStopReason(v: unknown): v is string {
  return str(v) && STOP_REASONS.has(v);
}

/**
 * Ficheros de `outputs/` de una trama `workspace_files` (D2). La ruta tiene que
 * ser relativa y empezar por `outputs/`: es lo único que se le pedirá a Rust
 * guardar o abrir, y Rust vuelve a comprobarlo.
 */
export function workspaceFiles(v: unknown): WorkspaceFileInfo[] | null {
  if (!Array.isArray(v)) return null;
  const files: WorkspaceFileInfo[] = [];
  for (const f of v) {
    if (!isRecord(f) || !str(f.path) || !str(f.name) || !num(f.size) || !str(f.mime)) continue;
    if (!f.path.startsWith('outputs/') || f.path.split('/').includes('..')) continue;
    files.push({
      path: f.path,
      name: f.name,
      size: f.size,
      mime: f.mime,
      modifiedAt: str(f.modifiedAt) ? f.modifiedAt : '',
    });
  }
  return files;
}

const WORKSPACE_STATES = new Set(['active', 'restoring', 'archived', 'purged']);
const isoOrNull = (v: unknown): v is string | null =>
  v === null || (str(v) && !Number.isNaN(Date.parse(v)));

/** Estado de retención del workspace (D3), de `conversation_opened` o `workspace_status`. */
export function workspaceStatus(v: unknown): WorkspaceStatus | null {
  if (!isRecord(v) || !str(v.state) || !WORKSPACE_STATES.has(v.state) || !bool(v.pinned)) {
    return null;
  }
  if (!str(v.lastUsedAt) || !isoOrNull(v.purgeAt) || !isoOrNull(v.filesExpiredAt)) return null;
  return {
    state: v.state as WorkspaceStatus['state'],
    pinned: v.pinned,
    lastUsedAt: v.lastUsedAt,
    purgeAt: v.purgeAt,
    filesExpiredAt: v.filesExpiredAt,
    // Un sidecar anterior a D4 no manda el tamaño.
    sizeBytes: num(v.sizeBytes) ? v.sizeBytes : 0,
  };
}

// ---------------------------------------------------------------------------
// D4: transcript, listado, estadísticas y memoria
// ---------------------------------------------------------------------------

const TOOL_STATES = new Set(['pending', 'running', 'completed', 'error']);
const TURN_STATUSES = new Set(['queued', 'streaming', 'done', 'cancelled', 'error', 'interrupted']);

function transcriptPart(v: unknown): TranscriptPart | null {
  if (!isRecord(v)) return null;
  if (v.kind === 'text' && str(v.text)) return { kind: 'text', text: v.text };
  if (v.kind === 'reasoning' && str(v.text)) return { kind: 'reasoning', text: v.text };
  if (v.kind === 'tool' && str(v.id)) return { kind: 'tool', id: v.id };
  if (v.kind === 'notice' && (v.tone === 'warning' || v.tone === 'error') && str(v.text)) {
    return { kind: 'notice', tone: v.tone, text: v.text };
  }
  return null;
}

function toolCall(v: unknown): TranscriptToolCall | null {
  if (!isRecord(v) || !str(v.id) || !str(v.name) || !str(v.state) || !str(v.input)) return null;
  if (!TOOL_STATES.has(v.state)) return null;
  return {
    id: v.id,
    name: v.name,
    state: v.state as TranscriptToolCall['state'],
    input: v.input,
    ...(str(v.output) ? { output: v.output } : {}),
    ...(str(v.error) ? { error: v.error } : {}),
    ...(num(v.durationMs) ? { durationMs: v.durationMs } : {}),
  };
}

/** Un turno del transcript. Lo que no encaja invalida el turno (no el transcript entero). */
export function transcriptTurn(v: unknown): TranscriptTurn | null {
  if (!isRecord(v) || !str(v.turnId) || !isRecord(v.user) || !str(v.user.text)) return null;
  if (!str(v.status) || !TURN_STATUSES.has(v.status) || !isRecord(v.toolCalls)) return null;
  const parts = all(v.parts, transcriptPart);
  if (!parts) return null;
  const toolCalls: Record<string, TranscriptToolCall> = {};
  for (const [id, raw] of Object.entries(v.toolCalls)) {
    const call = toolCall(raw);
    if (!call || call.id !== id) return null;
    toolCalls[id] = call;
  }
  const attachments = Array.isArray(v.user.attachments)
    ? v.user.attachments.flatMap((a) =>
        isRecord(a) && str(a.path) && str(a.name) && num(a.size)
          ? [{ path: a.path, name: a.name, size: a.size }]
          : [],
      )
    : [];
  const files = v.files === undefined ? undefined : workspaceFiles(v.files);
  return {
    turnId: v.turnId,
    user: { text: v.user.text, ...(attachments.length > 0 ? { attachments } : {}) },
    parts,
    toolCalls,
    status: v.status as TranscriptTurn['status'],
    ...(str(v.stopReason) ? { stopReason: v.stopReason } : {}),
    ...(files && files.length > 0 ? { files } : {}),
    startedAt: str(v.startedAt) ? v.startedAt : '',
  };
}

export function transcript(v: unknown): TranscriptTurn[] | null {
  if (!Array.isArray(v)) return null;
  return v.flatMap((t) => {
    const turn = transcriptTurn(t);
    return turn ? [turn] : [];
  });
}

export function conversationStats(v: unknown): ConversationStats | null {
  if (!isRecord(v) || !str(v.provider) || !str(v.model) || !isRecord(v.context)) return null;
  const c = v.context;
  if (!num(c.used) || !num(c.max) || !num(c.pct) || !bool(c.estimated)) return null;
  return {
    provider: v.provider,
    model: v.model,
    context: { used: c.used, max: c.max, pct: c.pct, estimated: c.estimated },
  };
}

export function conversationSummary(v: unknown): ConversationSummary | null {
  if (!isRecord(v) || !str(v.conversationId) || !str(v.title) || !bool(v.titleEdited)) return null;
  if (!str(v.createdAt) || !str(v.updatedAt) || !str(v.provider) || !str(v.model)) return null;
  if (!num(v.turnCount)) return null;
  const workspace = v.workspace === null ? null : workspaceStatus(v.workspace);
  if (v.workspace !== null && workspace === null) return null;
  return {
    conversationId: v.conversationId,
    title: v.title,
    titleEdited: v.titleEdited,
    createdAt: v.createdAt,
    updatedAt: v.updatedAt,
    provider: v.provider,
    model: v.model,
    turnCount: v.turnCount,
    workspace,
  };
}

export function conversationSummaries(v: unknown): ConversationSummary[] | null {
  if (!Array.isArray(v)) return null;
  return v.flatMap((x) => {
    const s = conversationSummary(x);
    return s ? [s] : [];
  });
}

export function todoItems(v: unknown): TodoItem[] | null {
  return all(v, todoItem);
}

export function decisionSummaries(v: unknown): DecisionSummary[] | null {
  if (!Array.isArray(v)) return null;
  return v.flatMap((d) =>
    isRecord(d) && str(d.id) && str(d.title) && str(d.content) && str(d.type) && str(d.importance)
      ? [
          {
            id: d.id,
            title: d.title,
            content: d.content,
            type: d.type,
            importance: d.importance,
            tags: Array.isArray(d.tags) ? d.tags.filter(str) : [],
            timestamp: str(d.timestamp) ? d.timestamp : '',
          },
        ]
      : [],
  );
}

export const isNullableNumber = (v: unknown): v is number | null => v === null || num(v);

const nullableStr = (v: unknown): v is string | null => v === null || str(v);

// ---------------------------------------------------------------------------
// Ajustes (D5)
// ---------------------------------------------------------------------------

export function configSnapshot(v: unknown): ConfigSnapshot | null {
  if (!isRecord(v) || !str(v.path) || !bool(v.exists) || !str(v.text)) return null;
  if (!nullableStr(v.hash) || !nullableStr(v.parseError) || !nullableStr(v.readOnly)) return null;
  return {
    path: v.path,
    exists: v.exists,
    text: v.text,
    hash: v.hash,
    parseError: v.parseError,
    readOnly: v.readOnly,
    overrides: Array.isArray(v.overrides) ? v.overrides.filter(str) : [],
  };
}

export function configApplied(v: unknown): ConfigApplied | null {
  if (!isRecord(v) || !bool(v.ok) || !nullableStr(v.error)) return null;
  return {
    ok: v.ok,
    error: v.error,
    restartRequired: Array.isArray(v.restartRequired) ? v.restartRequired.filter(str) : [],
    os: osPrefs(v.os),
    // Ausente = no hay motivo para lanzar el onboarding.
    providerReady: v.providerReady !== false,
  };
}

/** `applied.os` (D6), con los defaults del schema en lo que falte o no cuadre. */
export function osPrefs(v: unknown): DesktopOsPrefs {
  const n = isRecord(v) && isRecord(v.notifications) ? v.notifications : {};
  return {
    notifications: {
      enabled: typeof n.enabled === 'boolean' ? n.enabled : true,
      minSeconds: num(n.minSeconds) && n.minSeconds >= 0 ? n.minSeconds : 10,
    },
    globalHotkey: isRecord(v) && str(v.globalHotkey) ? v.globalHotkey : DEFAULT_GLOBAL_HOTKEY,
    updates: {
      autoCheck: !(isRecord(v) && isRecord(v.updates) && v.updates.autoCheck === false),
    },
  };
}

export function configIssues(v: unknown): ConfigIssue[] | null {
  if (!Array.isArray(v)) return null;
  return v.flatMap((i) =>
    isRecord(i) && str(i.path) && str(i.message)
      ? [
          {
            path: i.path,
            message: i.message,
            ...(num(i.line) ? { line: i.line } : {}),
            ...(num(i.column) ? { column: i.column } : {}),
          },
        ]
      : [],
  );
}
