import type { TodoItem } from '../../../../stratum-cli/src/agent/events';

const ICON: Record<TodoItem['status'], string> = {
  pending: '○',
  in_progress: '◐',
  done: '✓',
  skipped: '⊘',
};

/** Lista de tareas del asistente (tool `todo`). Solo se pinta si hay tareas. */
export function TodoPanel({ items }: { items: TodoItem[] }) {
  if (items.length === 0) return null;
  const done = items.filter((t) => t.status === 'done').length;
  return (
    <section className="todo-panel" aria-label="Tareas del asistente">
      <div className="todo-panel__header">
        Tareas · {done}/{items.length}
      </div>
      <ul className="todo-panel__list">
        {items.map((t) => (
          <li key={t.id} data-status={t.status}>
            <span aria-hidden="true">{ICON[t.status]}</span> {t.title}
          </li>
        ))}
      </ul>
    </section>
  );
}
