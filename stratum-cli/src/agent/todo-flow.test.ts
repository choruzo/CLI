import { describe, it, expect } from 'vitest';
import { ReactLoop } from './harness.js';
import { ToolRegistry } from '../tools/registry.js';
import { registerBuiltinTools } from '../tools/index.js';
import { MockProvider, makeTextRound, makeToolCallRound } from '../providers/mock.js';
import { StratumConfigSchema } from '../config/schema.js';
import { TodoList, TODO_STALE_TURNS, parseTodoSnapshot, type TodoItem } from './todo.js';
import { buildWorkRoutingBlock, buildSystemPrompt } from './system-prompt.js';
import { isToolVisibleInMode, isToolVisibleForProfile } from '../tools/registry.js';
import type { AgentEvent, Message } from './types.js';

const config = StratumConfigSchema.parse({});

async function collect(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const ev of gen) events.push(ev);
  return events;
}

function newRegistry(): ToolRegistry {
  const r = new ToolRegistry();
  registerBuiltinTools(r, config);
  return r;
}

describe('tool todo — flujo del loop (Hito 11)', () => {
  it('se intercepta: no se despacha y devuelve el snapshot completo', async () => {
    const provider = new MockProvider([
      makeToolCallRound('c1', 'todo', {
        action: 'write',
        items: [{ title: 'Leer el harness' }, { title: 'Escribir tests' }],
      }),
      makeTextRound('Listo.'),
    ]);
    const messages: Message[] = [{ role: 'system', content: 'sys' }];
    const todos = new TodoList();
    const loop = new ReactLoop(provider, newRegistry(), messages, config, 'm', 32768, undefined, {
      todos,
    });

    const events = await collect(loop.run({}));

    const updated = events.find((e) => e.type === 'todo_updated') as {
      items: TodoItem[];
      stale: number;
    };
    expect(updated.items.map((i) => i.title)).toEqual(['Leer el harness', 'Escribir tests']);

    const injected = messages.find((m) => m.role === 'tool' && m.name === 'todo');
    expect(parseTodoSnapshot(injected!.content!)).toHaveLength(2);
    expect(events.at(-1)).toEqual({ type: 'done', stopReason: 'stop' });
  });

  it('reinyecta las tareas abiertas en el system prompt antes de cada iteración', async () => {
    const provider = new MockProvider([
      makeToolCallRound('c1', 'todo', {
        action: 'write',
        items: [{ title: 'Tarea abierta', status: 'in_progress' }],
      }),
      makeTextRound('ok'),
    ]);
    const messages: Message[] = [{ role: 'system', content: 'sys' }];
    const loop = new ReactLoop(provider, newRegistry(), messages, config, 'm', 32768, undefined, {
      todos: new TodoList(),
    });

    await collect(loop.run({}));

    // La segunda iteración ya compuso el prompt con el bloque dentro.
    expect(messages[0]!.content).toContain('# Todo list');
    expect(messages[0]!.content).toContain('Tarea abierta');
  });

  it('marca staleness cuando pasan turnos sin tocar la lista', async () => {
    const todos = new TodoList();
    todos.apply({ action: 'write', items: [{ title: 'Pendiente' }] });
    for (let i = 0; i < TODO_STALE_TURNS - 1; i++) todos.beginTurn();

    const messages: Message[] = [{ role: 'system', content: 'sys' }];
    const loop = new ReactLoop(
      new MockProvider([makeTextRound('nada')]),
      newRegistry(),
      messages,
      config,
      'm',
      32768,
      undefined,
      { todos },
    );

    const events = await collect(loop.run({}));
    const updated = events.find((e) => e.type === 'todo_updated') as { stale: number };
    expect(updated.stale).toBe(TODO_STALE_TURNS);
    expect(messages[0]!.content).toContain('stale:');
  });

  it('un error de la lista vuelve como tool_error recuperable, no rompe el turno', async () => {
    const provider = new MockProvider([
      makeToolCallRound('c1', 'todo', { action: 'update', id: 'inexistente', status: 'done' }),
      makeTextRound('reintento'),
    ]);
    const messages: Message[] = [{ role: 'system', content: 'sys' }];
    const loop = new ReactLoop(provider, newRegistry(), messages, config, 'm', 32768, undefined, {
      todos: new TodoList(),
    });

    const events = await collect(loop.run({}));
    const err = events.find((e) => e.type === 'tool_error') as { recoverable: boolean };
    expect(err.recoverable).toBe(true);
    expect(events.at(-1)).toEqual({ type: 'done', stopReason: 'stop' });
  });

  it('en modo execute se rechaza: el checklist del plan es la fuente de verdad', async () => {
    const provider = new MockProvider([
      makeToolCallRound('c1', 'todo', { action: 'write', items: [{ title: 'X' }] }),
      makeTextRound('vale'),
    ]);
    const messages: Message[] = [{ role: 'system', content: 'sys' }];
    const loop = new ReactLoop(provider, newRegistry(), messages, config, 'm', 32768, undefined, {
      todos: new TodoList(),
    });

    const events = await collect(
      loop.run({
        mode: 'execute',
        plan: { summary: 's', steps: [{ id: 'step-1', title: 'a', status: 'pending' }] },
        isResumePlan: true,
      }),
    );
    const err = events.find((e) => e.type === 'tool_error') as { error: string };
    expect(err.error).toContain('update_plan');
  });

  it('queda fuera del toolset en plan/execute y para los subagentes', () => {
    expect(isToolVisibleInMode('todo', 'normal')).toBe(true);
    expect(isToolVisibleInMode('todo', 'plan')).toBe(false);
    expect(isToolVisibleInMode('todo', 'execute')).toBe(false);
    expect(isToolVisibleForProfile('todo', { isSubagent: true })).toBe(false);
    expect(isToolVisibleForProfile('todo', { isSubagent: false })).toBe(true);
  });
});

describe('work routing — bloque de system prompt (Hito 11)', () => {
  it('sin perfiles de agente no se inyecta nada', () => {
    expect(buildWorkRoutingBlock([])).toBe('');
    expect(buildSystemPrompt(config, undefined, { agentProfiles: [] })).not.toContain(
      '# Work routing',
    );
  });

  it('con perfiles remite al índice de perfiles y lista los umbrales de delegación', () => {
    const block = buildWorkRoutingBlock(['general', 'research', 'code']);
    // Hito 15: los nombres viven en `# Agent profiles`, no aquí — así el cuerpo
    // de la guía no cambia cada vez que se añade un perfil.
    expect(block).toContain('# Agent profiles');
    expect(block).not.toContain('general, research, code');
    expect(block).toContain('Four-file rule');
    expect(block).toContain('Multi-write rule');
    expect(block).toContain('Long-session rule');
  });

  it('un subagente no lo recibe: no puede delegar', () => {
    const prompt = buildSystemPrompt(config, undefined, {
      agentProfiles: ['general'],
      isSubagent: true,
    });
    expect(prompt).not.toContain('# Work routing');
  });

  it('el bloque de idioma separa conversación, artefactos técnicos y subagentes', () => {
    const prompt = buildSystemPrompt(config, undefined, {});
    expect(prompt).toContain('Technical artifacts — English by default');
    expect(prompt).toContain('Prompts you write for subagents');
  });
});
