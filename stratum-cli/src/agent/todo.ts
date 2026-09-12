/**
 * Hito 11 — Lista de tareas del turno (`todo`).
 *
 * El escalón ligero que faltaba entre "nada" y `present_plan`. Un plan formal
 * es caro: gate de aprobación, persistencia en `.stratum/plans/`, tres fases.
 * Para trabajo de 3-8 pasos eso sobra, pero dejar al modelo sin ningún soporte
 * externo hace que pierda el hilo a mitad de la tarea.
 *
 * Tres decisiones sostienen el diseño (adaptadas de gentle-pi, Alan Buscaglia,
 * MIT — ver CLI-DOC/Investigacion/gentle-pi.md §2):
 *
 *  1. `write` reemplaza la lista entera conservando los ids de las tareas que ya
 *     existían. El modelo reescribe el plan y ya; no tiene que calcular diffs.
 *  2. El bloque de tareas abiertas se reinyecta en el system prompt en cada
 *     iteración. La descripción estática de la tool NO basta para que un modelo
 *     pequeño mantenga la lista al día; recordárselo constantemente sí.
 *  3. Staleness: si pasan >= 2 turnos con tareas abiertas y sin tocar `todo`,
 *     la inyección lo dice explícitamente y la UI lo marca.
 *
 * El estado vive en el historial (cada tool result lleva el snapshot completo),
 * así que `chat --resume` lo recupera sin store nuevo en disco.
 */
import type { Message, PlanStepStatus } from './types.js';

/** Mismo vocabulario de estado que los pasos de plan, para no duplicarlo. */
export type TodoStatus = PlanStepStatus;

export interface TodoItem {
  id: string;
  title: string;
  status: TodoStatus;
}

/** Turnos sin tocar `todo` con tareas abiertas a partir de los cuales se avisa. */
export const TODO_STALE_TURNS = 2;

/** Tope de tareas: una lista más larga que esto es un plan, no un todo. */
export const MAX_TODO_ITEMS = 30;

/** Filas visibles en la UI antes de colapsar las `done` (UI §5.9). */
export const TODO_VISIBLE_ROWS = 12;

const STATUS_VALUES: readonly TodoStatus[] = ['pending', 'in_progress', 'done', 'skipped'];

export type TodoAction = 'write' | 'add' | 'update' | 'clear' | 'list';

export interface TodoInput {
  action: TodoAction;
  items?: Array<{ id?: string; title?: string; status?: string }>;
  id?: string;
  title?: string;
  status?: string;
}

export interface TodoApplyResult {
  items: TodoItem[];
  /** Notas para el modelo (invariantes corregidas, avisos). */
  notes: string[];
}

function normalizeTitle(title: string): string {
  return title.trim().replace(/\s+/g, ' ').toLowerCase();
}

function coerceStatus(raw: unknown, fallback: TodoStatus = 'pending'): TodoStatus {
  const value = String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  return (STATUS_VALUES as readonly string[]).includes(value) ? (value as TodoStatus) : fallback;
}

export function isTodoOpen(item: TodoItem): boolean {
  return item.status === 'pending' || item.status === 'in_progress';
}

/**
 * Invariante "exactamente una tarea in_progress". Cuando el modelo marca varias
 * se conserva la ÚLTIMA (es la que acaba de empezar) y el resto vuelve a
 * `pending`; la corrección se le devuelve como nota para que lo aprenda.
 */
function enforceSingleInProgress(items: TodoItem[], notes: string[]): TodoItem[] {
  const inProgress = items.filter((i) => i.status === 'in_progress');
  if (inProgress.length <= 1) return items;
  const keep = inProgress[inProgress.length - 1]!.id;
  notes.push(
    `Only one task may be in_progress at a time; kept "${
      inProgress[inProgress.length - 1]!.title
    }" and moved the other ${inProgress.length - 1} back to pending.`,
  );
  return items.map((i) =>
    i.status === 'in_progress' && i.id !== keep ? { ...i, status: 'pending' as TodoStatus } : i,
  );
}

/**
 * Aplica una acción sobre la lista. Función pura: devuelve una lista nueva.
 * Lanza `TodoError` solo ante entradas que el modelo puede corregir (id
 * inexistente, lista vacía en `write`).
 */
export class TodoError extends Error {}

export function applyTodoAction(current: TodoItem[], input: TodoInput): TodoApplyResult {
  const notes: string[] = [];

  switch (input.action) {
    case 'list':
      return { items: current, notes };

    case 'clear':
      return { items: [], notes };

    case 'write': {
      const incoming = (input.items ?? []).filter((i) => (i.title ?? '').trim().length > 0);
      if (incoming.length === 0) {
        throw new TodoError(
          'write needs a non-empty items array. Use action "clear" to empty the list.',
        );
      }
      if (incoming.length > MAX_TODO_ITEMS) {
        throw new TodoError(
          `The list cannot hold more than ${MAX_TODO_ITEMS} tasks. Split the work or use /plan.`,
        );
      }
      // Conservar los ids existentes: por id explícito, y si no, por título
      // normalizado. Así el modelo puede reescribir el plan entero sin perder
      // la identidad de lo que ya estaba en curso.
      const byId = new Map(current.map((i) => [i.id, i]));
      const byTitle = new Map(current.map((i) => [normalizeTitle(i.title), i]));
      const usedIds = new Set<string>();
      let counter = 0;

      const items: TodoItem[] = incoming.map((raw) => {
        const title = raw.title!.trim();
        const existing =
          (raw.id ? byId.get(raw.id) : undefined) ?? byTitle.get(normalizeTitle(title));
        let id: string;
        if (existing && !usedIds.has(existing.id)) {
          id = existing.id;
        } else {
          do {
            counter++;
            id = `t${counter}`;
          } while (usedIds.has(id) || byId.has(id));
        }
        usedIds.add(id);
        return {
          id,
          title,
          status: coerceStatus(raw.status, existing?.status ?? 'pending'),
        };
      });

      return { items: enforceSingleInProgress(items, notes), notes };
    }

    case 'add': {
      const incoming = (input.items ?? []).filter((i) => (i.title ?? '').trim().length > 0);
      if (incoming.length === 0) {
        throw new TodoError('add needs a non-empty items array.');
      }
      if (current.length + incoming.length > MAX_TODO_ITEMS) {
        throw new TodoError(
          `The list cannot hold more than ${MAX_TODO_ITEMS} tasks. Split the work or use /plan.`,
        );
      }
      const taken = new Set(current.map((i) => i.id));
      let counter = current.length;
      const added: TodoItem[] = incoming.map((raw) => {
        let id: string;
        do {
          counter++;
          id = `t${counter}`;
        } while (taken.has(id));
        taken.add(id);
        return { id, title: raw.title!.trim(), status: coerceStatus(raw.status) };
      });
      return { items: enforceSingleInProgress([...current, ...added], notes), notes };
    }

    case 'update': {
      const id = (input.id ?? '').trim();
      if (!id) throw new TodoError('update needs the id of the task to change.');
      const target = current.find((i) => i.id === id);
      if (!target) {
        const known = current.map((i) => i.id).join(', ') || '(the list is empty)';
        throw new TodoError(`No task with id "${id}". Known ids: ${known}.`);
      }
      const items = current.map((i) =>
        i.id === id
          ? {
              ...i,
              title: (input.title ?? '').trim() || i.title,
              status: input.status !== undefined ? coerceStatus(input.status, i.status) : i.status,
            }
          : i,
      );
      return { items: enforceSingleInProgress(items, notes), notes };
    }

    default:
      throw new TodoError(
        `Unknown action "${String(input.action)}". Use write, add, update, clear or list.`,
      );
  }
}

// ---------------------------------------------------------------------------
// Serialización: el snapshot viaja en el tool result (replay gratis al reanudar)
// ---------------------------------------------------------------------------

const STATUS_MARK: Record<TodoStatus, string> = {
  pending: '[ ]',
  in_progress: '[~]',
  done: '[x]',
  skipped: '[-]',
};

/**
 * Snapshot completo que se inyecta como tool result. Es la ÚNICA fuente de
 * verdad persistida: al reanudar una sesión se reconstruye el estado leyendo el
 * último de estos bloques del historial, sin fichero aparte.
 */
export function formatTodoSnapshot(items: TodoItem[], notes: string[] = []): string {
  const open = items.filter(isTodoOpen).length;
  const lines = items.map(
    (item, i) => `  ${i + 1}. ${STATUS_MARK[item.status]} ${item.id} ${item.title}`,
  );
  const body = items.length === 0 ? '  (empty)' : lines.join('\n');
  const noteLines = notes.length > 0 ? `\n  note: ${notes.join(' ')}` : '';
  return `<todo count="${items.length}" open="${open}">\n${body}${noteLines}\n</todo>`;
}

const SNAPSHOT_LINE = /^\s*\d+\.\s+\[([ x~-])\]\s+(\S+)\s+(.*)$/;
const MARK_TO_STATUS: Record<string, TodoStatus> = {
  ' ': 'pending',
  '~': 'in_progress',
  x: 'done',
  '-': 'skipped',
};

/** Inverso de `formatTodoSnapshot`. Devuelve `null` si el texto no es un snapshot. */
export function parseTodoSnapshot(text: string): TodoItem[] | null {
  if (!text.includes('<todo ')) return null;
  const items: TodoItem[] = [];
  let inside = false;
  for (const line of text.split('\n')) {
    if (line.includes('<todo ')) {
      inside = true;
      continue;
    }
    if (line.includes('</todo>')) break;
    if (!inside) continue;
    const match = SNAPSHOT_LINE.exec(line);
    if (!match) continue;
    items.push({
      id: match[2]!,
      title: match[3]!.trim(),
      status: MARK_TO_STATUS[match[1]!] ?? 'pending',
    });
  }
  return items;
}

/**
 * Reconstruye la lista al reanudar una sesión: el último snapshot del historial
 * gana. Recorre hacia atrás y para en el primero que encuentra.
 */
export function rehydrateTodos(messages: Message[]): TodoItem[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!;
    if (msg.role !== 'tool' || msg.name !== 'todo' || !msg.content) continue;
    const parsed = parseTodoSnapshot(msg.content);
    if (parsed) return parsed;
  }
  return [];
}

// ---------------------------------------------------------------------------
// Inyección en el system prompt
// ---------------------------------------------------------------------------

export const TODO_BLOCK_START = '<!-- stratum:todo:start -->';
export const TODO_BLOCK_END = '<!-- stratum:todo:end -->';

/**
 * Bloque que se reinyecta en el system prompt antes de cada iteración. Cadena
 * vacía cuando no hay nada abierto: una lista terminada desaparece del contexto
 * al turno siguiente en lugar de quedarse ocupando tokens.
 */
export function buildTodoInjection(items: TodoItem[], staleTurns: number): string {
  const open = items.filter(isTodoOpen);
  if (open.length === 0) return '';

  const finished = items.length - open.length;
  const lines = items
    .filter(isTodoOpen)
    .map((item) => `- [${item.id}] ${item.status}: ${item.title}`);

  const staleLine =
    staleTurns >= TODO_STALE_TURNS
      ? `\n(stale: ${staleTurns} turns without an update — bring the list up to date now)`
      : '';
  const doneLine = finished > 0 ? `\n${finished} task(s) already finished.` : '';

  return `# Todo list
These are the tasks you are currently tracking with the \`todo\` tool:
${lines.join('\n')}${doneLine}${staleLine}

Keep this list accurate as you work: exactly one task in_progress, mark it done the moment it is finished.`;
}

/**
 * Refresca el bloque dentro del mensaje `system` (índice 0), entre marcadores.
 * Se inyecta ahí y no como mensaje nuevo por dos razones: es idempotente (no
 * acumula basura por iteración) y sobrevive a la compresión de contexto, que
 * protege el system prompt. Devuelve true si el mensaje cambió.
 */
export function applyTodoToSystemMessage(messages: Message[], block: string): boolean {
  const system = messages[0];
  if (!system || system.role !== 'system' || typeof system.content !== 'string') return false;

  const section = block ? `${TODO_BLOCK_START}\n${block}\n${TODO_BLOCK_END}` : '';
  const start = system.content.indexOf(TODO_BLOCK_START);
  const end = system.content.indexOf(TODO_BLOCK_END);

  let next: string;
  if (start !== -1 && end !== -1 && end > start) {
    const before = system.content.slice(0, start).replace(/\n+$/, '');
    const after = system.content.slice(end + TODO_BLOCK_END.length).replace(/^\n+/, '');
    next = [before, section, after].filter((p) => p.length > 0).join('\n\n');
  } else {
    if (!section) return false;
    next = `${system.content}\n\n${section}`;
  }

  if (next === system.content) return false;
  messages[0] = { ...system, content: next };
  return true;
}

/**
 * Estado vivo de la lista durante una sesión. Lo posee `StratumAgent` (el
 * `ReactLoop` dura un solo turno) y se lo pasa al loop por `extras`.
 */
export class TodoList {
  private items: TodoItem[] = [];
  private turnsWithoutUpdate = 0;

  constructor(initial: TodoItem[] = []) {
    this.items = initial;
  }

  get snapshot(): TodoItem[] {
    return [...this.items];
  }

  get openCount(): number {
    return this.items.filter(isTodoOpen).length;
  }

  get staleTurns(): number {
    return this.turnsWithoutUpdate;
  }

  get isStale(): boolean {
    return this.openCount > 0 && this.turnsWithoutUpdate >= TODO_STALE_TURNS;
  }

  /**
   * Arranque de turno. Una lista sin tareas abiertas se limpia aquí (la
   * "lista terminada se limpia al turno siguiente"), y el contador de staleness
   * avanza solo si quedaba trabajo pendiente.
   */
  beginTurn(): void {
    if (this.items.length > 0 && this.openCount === 0) {
      this.items = [];
      this.turnsWithoutUpdate = 0;
      return;
    }
    if (this.openCount > 0) this.turnsWithoutUpdate++;
  }

  apply(input: TodoInput): TodoApplyResult {
    const result = applyTodoAction(this.items, input);
    this.items = result.items;
    if (input.action !== 'list') this.turnsWithoutUpdate = 0;
    return result;
  }

  /** Bloque a inyectar en el system prompt para la iteración actual. */
  injection(): string {
    return buildTodoInjection(this.items, this.turnsWithoutUpdate);
  }

  replace(items: TodoItem[]): void {
    this.items = items;
    this.turnsWithoutUpdate = 0;
  }

  clear(): void {
    this.items = [];
    this.turnsWithoutUpdate = 0;
  }
}
