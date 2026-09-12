import { describe, it, expect } from 'vitest';
import {
  TodoList,
  applyTodoAction,
  buildTodoInjection,
  formatTodoSnapshot,
  parseTodoSnapshot,
  rehydrateTodos,
  applyTodoToSystemMessage,
  TODO_STALE_TURNS,
  MAX_TODO_ITEMS,
  TodoError,
  type TodoItem,
} from './todo.js';
import type { Message } from './types.js';

const items = (...titles: string[]): Array<{ title: string }> => titles.map((title) => ({ title }));

describe('todo — acciones', () => {
  it('write reemplaza la lista entera', () => {
    const first = applyTodoAction([], { action: 'write', items: items('A', 'B') }).items;
    const second = applyTodoAction(first, { action: 'write', items: items('C') }).items;
    expect(second.map((i) => i.title)).toEqual(['C']);
  });

  it('write conserva el id y el estado de una tarea que ya existía', () => {
    const first = applyTodoAction([], { action: 'write', items: items('Leer', 'Escribir') }).items;
    const started = applyTodoAction(first, {
      action: 'update',
      id: first[0]!.id,
      status: 'in_progress',
    }).items;
    // El modelo reescribe el plan entero añadiendo un paso al principio.
    const rewritten = applyTodoAction(started, {
      action: 'write',
      items: [{ title: 'Investigar' }, { title: 'Leer' }, { title: 'Escribir' }],
    }).items;

    const leer = rewritten.find((i) => i.title === 'Leer')!;
    expect(leer.id).toBe(first[0]!.id);
    expect(leer.status).toBe('in_progress');
  });

  it('write empareja por título aunque el modelo no mande ids', () => {
    const first = applyTodoAction([], { action: 'write', items: items('Añadir  tests') }).items;
    const again = applyTodoAction(first, { action: 'write', items: items('añadir tests') }).items;
    expect(again[0]!.id).toBe(first[0]!.id);
  });

  it('add anexa sin tocar lo existente y update cambia una sola tarea', () => {
    const base = applyTodoAction([], { action: 'write', items: items('A') }).items;
    const added = applyTodoAction(base, { action: 'add', items: items('B') }).items;
    expect(added.map((i) => i.title)).toEqual(['A', 'B']);

    const updated = applyTodoAction(added, {
      action: 'update',
      id: added[1]!.id,
      status: 'done',
    }).items;
    expect(updated[0]!.status).toBe('pending');
    expect(updated[1]!.status).toBe('done');
  });

  it('mantiene exactamente una tarea in_progress y lo explica', () => {
    const result = applyTodoAction([], {
      action: 'write',
      items: [
        { title: 'A', status: 'in_progress' },
        { title: 'B', status: 'in_progress' },
      ],
    });
    expect(result.items.filter((i) => i.status === 'in_progress')).toHaveLength(1);
    expect(result.items[1]!.status).toBe('in_progress');
    expect(result.notes.join(' ')).toContain('one task');
  });

  it('rechaza entradas que el modelo puede corregir', () => {
    expect(() => applyTodoAction([], { action: 'write', items: [] })).toThrow(TodoError);
    expect(() => applyTodoAction([], { action: 'update', id: 'nope', status: 'done' })).toThrow(
      TodoError,
    );
    expect(() =>
      applyTodoAction([], {
        action: 'write',
        items: items(...Array.from({ length: MAX_TODO_ITEMS + 1 }, (_, i) => `t${i}`)),
      }),
    ).toThrow(TodoError);
  });

  it('clear vacía y list no cambia nada', () => {
    const base = applyTodoAction([], { action: 'write', items: items('A') }).items;
    expect(applyTodoAction(base, { action: 'list' }).items).toEqual(base);
    expect(applyTodoAction(base, { action: 'clear' }).items).toEqual([]);
  });
});

describe('todo — snapshot y rehidratación', () => {
  it('el snapshot es un round-trip completo', () => {
    const original: TodoItem[] = [
      { id: 't1', title: 'Leer el harness', status: 'done' },
      { id: 't2', title: 'Añadir la tool', status: 'in_progress' },
      { id: 't3', title: 'Escribir tests', status: 'pending' },
      { id: 't4', title: 'Publicar', status: 'skipped' },
    ];
    expect(parseTodoSnapshot(formatTodoSnapshot(original))).toEqual(original);
  });

  it('reconstruye el estado desde el último snapshot del historial', () => {
    const messages: Message[] = [
      { role: 'system', content: 'sys' },
      {
        role: 'tool',
        name: 'todo',
        tool_call_id: 'a',
        content: formatTodoSnapshot([{ id: 't1', title: 'Vieja', status: 'pending' }]),
      },
      {
        role: 'tool',
        name: 'todo',
        tool_call_id: 'b',
        content: formatTodoSnapshot([{ id: 't1', title: 'Nueva', status: 'in_progress' }]),
      },
    ];
    expect(rehydrateTodos(messages)).toEqual([{ id: 't1', title: 'Nueva', status: 'in_progress' }]);
  });

  it('un historial sin snapshots da una lista vacía', () => {
    expect(rehydrateTodos([{ role: 'user', content: 'hola' }])).toEqual([]);
  });
});

describe('todo — inyección en el system prompt', () => {
  const open: TodoItem[] = [
    { id: 't1', title: 'Hecho', status: 'done' },
    { id: 't2', title: 'En curso', status: 'in_progress' },
  ];

  it('lista solo las tareas abiertas y cuenta las terminadas', () => {
    const block = buildTodoInjection(open, 0);
    expect(block).toContain('[t2] in_progress: En curso');
    expect(block).not.toContain('[t1]');
    expect(block).toContain('1 task(s) already finished');
  });

  it('sin tareas abiertas no inyecta nada', () => {
    expect(buildTodoInjection([{ id: 't1', title: 'Hecho', status: 'done' }], 5)).toBe('');
  });

  it('avisa de staleness a partir del umbral', () => {
    expect(buildTodoInjection(open, TODO_STALE_TURNS - 1)).not.toContain('stale:');
    expect(buildTodoInjection(open, TODO_STALE_TURNS)).toContain('stale:');
  });

  it('el bloque se reemplaza en el system prompt, no se acumula', () => {
    const messages: Message[] = [{ role: 'system', content: 'base' }];
    applyTodoToSystemMessage(messages, 'primero');
    applyTodoToSystemMessage(messages, 'segundo');
    const content = messages[0]!.content!;
    expect(content).toContain('base');
    expect(content).toContain('segundo');
    expect(content).not.toContain('primero');
    expect(content.match(/stratum:todo:start/g)).toHaveLength(1);
  });

  it('un bloque vacío retira la sección y deja el prompt original', () => {
    const messages: Message[] = [{ role: 'system', content: 'base' }];
    applyTodoToSystemMessage(messages, 'algo');
    applyTodoToSystemMessage(messages, '');
    expect(messages[0]!.content).toBe('base');
  });

  it('no toca nada si el primer mensaje no es el system prompt', () => {
    const messages: Message[] = [{ role: 'user', content: 'hola' }];
    expect(applyTodoToSystemMessage(messages, 'algo')).toBe(false);
    expect(messages[0]!.content).toBe('hola');
  });
});

describe('todo — estado de sesión', () => {
  it('el contador de staleness avanza por turno y se reinicia al tocar la lista', () => {
    const list = new TodoList();
    list.apply({ action: 'write', items: items('A') });
    expect(list.staleTurns).toBe(0);

    list.beginTurn();
    list.beginTurn();
    expect(list.staleTurns).toBe(TODO_STALE_TURNS);
    expect(list.isStale).toBe(true);

    list.apply({ action: 'update', id: 't1', status: 'in_progress' });
    expect(list.staleTurns).toBe(0);
    expect(list.isStale).toBe(false);
  });

  it('list no cuenta como actualización: leer no es mantener la lista al día', () => {
    const list = new TodoList();
    list.apply({ action: 'write', items: items('A') });
    list.beginTurn();
    list.apply({ action: 'list' });
    expect(list.staleTurns).toBe(1);
  });

  it('una lista terminada se limpia al turno siguiente', () => {
    const list = new TodoList();
    list.apply({ action: 'write', items: items('A') });
    list.apply({ action: 'update', id: 't1', status: 'done' });
    expect(list.snapshot).toHaveLength(1);
    list.beginTurn();
    expect(list.snapshot).toHaveLength(0);
  });
});
