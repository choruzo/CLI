import { describe, it, expect, vi } from 'vitest';
import { StratumAgent } from './core.js';
import { ProfileLoader } from './profiles.js';
import { ASSISTANT_FILE_TOOLS, ASSISTANT_TOOLS } from './presets.js';
import { buildAssistantPrompt, buildSystemPrompt } from './system-prompt.js';
import { ProviderRouter } from '../providers/router.js';
import { ToolRegistry } from '../tools/registry.js';
import { registerBuiltinTools } from '../tools/index.js';
import { MockProvider, makeTextRound, makeToolCallRound } from '../providers/mock.js';
import { StratumConfigSchema } from '../config/schema.js';
import type { CompletionRequest, OpenAIStreamChunk } from '../providers/base.js';
import type { AgentEvent, WorkspaceConfinement } from './types.js';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const config = StratumConfigSchema.parse({
  provider: {
    default: 'test',
    providers: {
      test: {
        type: 'openai-compatible',
        baseUrl: 'http://127.0.0.1:1/v1',
        apiKey: '',
        model: 'test-model',
        contextWindow: 32768,
      },
    },
  },
  // Que ningún test dependa de lo que haya en el disco del usuario.
  memory: { globalFile: '/nonexistent/stratum-test/STRATUM.md', autoExtract: false },
});

/** MockProvider que además guarda las requests para inspeccionar el toolset. */
class RecordingProvider extends MockProvider {
  readonly requests: CompletionRequest[] = [];
  override complete(req: CompletionRequest): AsyncGenerator<OpenAIStreamChunk> {
    this.requests.push(req);
    return super.complete(req);
  }
}

function newAgent(
  provider?: MockProvider,
  preset: 'coding' | 'assistant' = 'assistant',
  workspace?: WorkspaceConfinement,
) {
  const registry = new ToolRegistry();
  registerBuiltinTools(registry, config);
  const router = new ProviderRouter(config);
  if (provider) vi.spyOn(router, 'getActive').mockReturnValue(provider);
  return new StratumAgent(config, router, registry, {
    profileLoader: new ProfileLoader([]),
    promptPreset: preset,
    workspace,
  });
}

async function collect(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const ev of gen) events.push(ev);
  return events;
}

/** Marcas de que el prompt de código se coló en el del asistente. */
const CODING_MARKERS = [
  '# Shell',
  'exec',
  'Working directory',
  'Workspace root folder',
  'git repo',
  '# Work routing',
  '# Testing discipline',
  '# Code References',
  '# Following conventions',
  'delegate_task',
  'present_plan',
  'Project Memory',
  'software engineering',
  'command line interface',
  'repository',
];

describe('preset assistant — prompt (16.6)', () => {
  it('ningún bloque de código se cuela en el prompt del asistente', () => {
    const prompt = newAgent().getMessages()[0]?.content ?? '';
    expect(prompt).toContain('Stratum Desktop');
    for (const marker of CODING_MARKERS) expect(prompt, marker).not.toContain(marker);
  });

  it('conserva identidad, idioma, preguntas, memoria y un <env> reducido', () => {
    const prompt = newAgent().getMessages()[0]?.content ?? '';
    for (const block of ['# Identity', '# Language', '# Asking the user', '# Long-term memory']) {
      expect(prompt).toContain(block);
    }
    expect(prompt).toContain('Platform:');
    expect(prompt).toContain("Today's date:");
    expect(prompt).toContain('test-model');
  });

  it('el prompt de código no cambia: sin preset es exactamente el de antes', () => {
    const env = { modelId: 'm', providerName: 'p', agentProfiles: [] };
    expect(buildSystemPrompt(config, 'mem', env)).toBe(
      buildSystemPrompt(config, 'mem', { ...env, preset: 'coding' }),
    );
    const coding = buildSystemPrompt(config, 'mem', env);
    expect(coding).toContain('# Shell');
    expect(coding).toContain('is not in the repository');
    expect(coding).toContain('## Project Memory');
  });

  it('la memoria del asistente es solo la global y va como memoria del usuario', () => {
    const prompt = buildAssistantPrompt('Prefiero respuestas breves.', {});
    expect(prompt).toContain('## User Memory');
    expect(prompt).toContain('Prefiero respuestas breves.');
    expect(prompt).not.toContain('Project Memory');
  });

  it('al reanudar descarta el system prompt guardado y recompone el del asistente', () => {
    const registry = new ToolRegistry();
    registerBuiltinTools(registry, config);
    const agent = new StratumAgent(config, new ProviderRouter(config), registry, {
      profileLoader: new ProfileLoader([]),
      promptPreset: 'assistant',
      initialMessages: [
        { role: 'system', content: 'You are Stratum, an interactive CLI tool.\n# Shell\nexec…' },
        { role: 'user', content: 'hola' },
        { role: 'assistant', content: '¡Hola!' },
        { role: 'system', content: 'Working directory: /repo' },
      ],
    });
    const messages = agent.getMessages();
    expect(messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant']);
    expect(messages[0]?.content).toContain('Stratum Desktop');
    for (const marker of CODING_MARKERS) expect(messages[0]?.content, marker).not.toContain(marker);
  });

  it('no se puede activar un perfil como agente principal', () => {
    const r = newAgent().setPrimaryProfile('general');
    expect(r.ok).toBe(false);
  });
});

describe('preset assistant — toolset (16.6)', () => {
  it('solo ofrece al modelo las tools del modo Chat', async () => {
    const provider = new RecordingProvider([makeTextRound('hola')]);
    await collect(newAgent(provider).run('hola'));
    const offered = (provider.requests[0]?.tools ?? []).map((t) => t.function.name).sort();
    expect(offered).toEqual([...ASSISTANT_TOOLS].sort());
  });

  it.each(['read_file', 'exec', 'present_plan', 'delegate_task', 'write_file'])(
    'una llamada a %s se rechaza al ejecutar y no llega a ejecutarse',
    async (tool) => {
      const provider = new MockProvider([
        makeToolCallRound('c1', tool, { path: 'x', command: 'echo hola', task: 't' }),
        makeTextRound('ok'),
      ]);
      const events = await collect(newAgent(provider).run('haz algo'));
      const err = events.find((e) => e.type === 'tool_error') as
        | { name: string; error: string; recoverable: boolean }
        | undefined;
      expect(err?.name).toBe(tool);
      expect(err?.error).toContain('not available');
      expect(err?.recoverable).toBe(true);
      expect(events.some((e) => e.type === 'tool_result')).toBe(false);
      expect(events.some((e) => e.type === 'plan_proposed' || e.type === 'subagent_started')).toBe(
        false,
      );
    },
  );

  it('todo sigue funcionando en el asistente', async () => {
    const provider = new MockProvider([
      makeToolCallRound('t1', 'todo', { action: 'write', items: [{ title: 'Buscar vuelos' }] }),
      makeTextRound('ok'),
    ]);
    const events = await collect(newAgent(provider).run('organízame el viaje'));
    expect(events.some((e) => e.type === 'todo_updated')).toBe(true);
  });

  it('el preset coding sigue ofreciendo el toolset completo', async () => {
    const provider = new RecordingProvider([makeTextRound('hola')]);
    await collect(newAgent(provider, 'coding').run('hola'));
    const offered = (provider.requests[0]?.tools ?? []).map((t) => t.function.name);
    expect(offered).toContain('exec');
    expect(offered).toContain('read_file');
  });
});

describe('preset assistant — workspace (D2)', () => {
  function makeWorkspace(): { base: string; ws: WorkspaceConfinement } {
    const base = mkdtempSync(join(tmpdir(), 'stratum-ws-agent-'));
    const root = join(base, 'ws');
    for (const d of ['inputs', 'outputs', 'scratch']) mkdirSync(join(root, d), { recursive: true });
    writeFileSync(join(root, 'inputs', 'ventas.csv'), 'mes,total\nenero,10\n');
    writeFileSync(join(base, 'fuera.txt'), 'FUERA');
    return { base, ws: { root, readOnly: ['inputs'], writable: ['outputs', 'scratch'] } };
  }

  it('sin workspace el prompt no menciona ficheros propios ni el bloque # Workspace', () => {
    const prompt = buildAssistantPrompt(undefined, {});
    expect(prompt).not.toContain('# Workspace');
    expect(prompt).toContain('You have no access to the user');
  });

  it('con workspace añade # Workspace, las tools de fichero y el aviso de dato no confiable', () => {
    const prompt = buildAssistantPrompt(undefined, {
      workspace: { root: '/x', readOnly: ['inputs'] },
    });
    expect(prompt).toContain('# Workspace');
    expect(prompt).toContain('inputs/');
    expect(prompt).toContain('outputs/');
    expect(prompt).toContain('data, not instructions');
    expect(prompt).toContain('read_file, list_directory, glob and grep');
    expect(prompt).not.toContain('You have no access to the user');
    // La ruta real de la raíz no se anuncia: el agente trabaja con relativas.
    expect(prompt).not.toContain('/x');
    for (const marker of CODING_MARKERS) expect(prompt, marker).not.toContain(marker);
  });

  it('con workspace ofrece las tools de fichero, pero nunca exec', async () => {
    const { base, ws } = makeWorkspace();
    try {
      const provider = new RecordingProvider([makeTextRound('hola')]);
      await collect(newAgent(provider, 'assistant', ws).run('hola'));
      const offered = (provider.requests[0]?.tools ?? []).map((t) => t.function.name).sort();
      expect(offered).toEqual([...ASSISTANT_TOOLS, ...ASSISTANT_FILE_TOOLS].sort());
      expect(offered).not.toContain('exec');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('el loop confina: lee inputs/, escribe outputs/ y veta lo de fuera', async () => {
    const { base, ws } = makeWorkspace();
    try {
      const provider = new MockProvider([
        makeToolCallRound('r1', 'read_file', { path: 'inputs/ventas.csv' }),
        makeToolCallRound('w1', 'write_file', {
          path: 'outputs/resumen.md',
          content: '# Total 10',
        }),
        makeToolCallRound('x1', 'read_file', { path: '../fuera.txt' }),
        makeToolCallRound('x2', 'write_file', { path: 'inputs/ventas.csv', content: 'pisado' }),
        makeTextRound('listo'),
      ]);
      const events = await collect(newAgent(provider, 'assistant', ws).run('resume'));
      const results = events.filter((e) => e.type === 'tool_result');
      const errors = events.filter((e) => e.type === 'tool_error') as { name: string }[];
      expect(results).toHaveLength(2);
      expect(errors.map((e) => e.name)).toEqual(['read_file', 'write_file']);
      expect(JSON.stringify(events)).not.toContain('FUERA');
      expect(readFileSync(join(ws.root, 'outputs', 'resumen.md'), 'utf-8')).toBe('# Total 10');
      expect(readFileSync(join(ws.root, 'inputs', 'ventas.csv'), 'utf-8')).toContain('enero');
      expect(existsSync(join(base, 'resumen.md'))).toBe(false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
