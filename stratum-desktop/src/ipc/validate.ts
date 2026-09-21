import type {
  AgentEvent,
  QuestionAnswer,
  QuestionItem,
  TodoItem,
} from '../../../stratum-cli/src/agent/events';

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

function todoItem(v: unknown): TodoItem | null {
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
