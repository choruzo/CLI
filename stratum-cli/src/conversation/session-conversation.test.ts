/**
 * M11 — el agente con conversación duradera: separación de las tres capas,
 * compactación a la memoria de sesión, procedencia, fallos, conversación
 * larga, aislamiento entre sesiones y el modelo de memoria configurado.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server } from 'http';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { AddressInfo } from 'net';
import { StratumAgent } from '../agent/core.js';
import type { AgentEvent } from '../agent/types.js';
import { SESSION_MEMORY_START } from '../agent/context-builder.js';
import { StratumConfigSchema, type StratumConfig } from '../config/schema.js';
import type { CompletionRequest, IProvider, OpenAIStreamChunk } from '../providers/base.js';
import { makeTextRound } from '../providers/mock.js';
import { ProviderRouter } from '../providers/router.js';
import { createSessionEnv } from '../runtime/session-env.js';
import { ToolRegistry } from '../tools/registry.js';
import { EXTRACTOR_PROMPT, SUMMARIZER_PROMPT } from './extract.js';
import { isLoopbackUrl, resolveMemoryModels } from './models.js';
import { SessionConversation } from './session-conversation.js';
import { MemoryConversationStore } from './store.js';

const dirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'stratum-m11-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Ids `eN` del trozo que ve el modelo de memoria, con el texto de cada `user`. */
function chunkUsers(prompt: string): Array<{ id: string; text: string }> {
  const out: Array<{ id: string; text: string }> = [];
  const re = /\[(e\d+) user\]\n([^\n]*)/g;
  for (let m = re.exec(prompt); m; m = re.exec(prompt)) out.push({ id: m[1]!, text: m[2]! });
  return out;
}

/**
 * Modelo de pruebas: el agente contesta un texto corto; el extractor saca un
 * hecho por cada mensaje de usuario que diga «dato: …», citando su id; el
 * resumen dice qué cubrió.
 */
class FakeModel implements IProvider {
  agentRequests: CompletionRequest[] = [];
  extractorPrompts: string[] = [];
  summaryPrompts: string[] = [];
  failExtractor = false;

  async *complete(req: CompletionRequest): AsyncGenerator<OpenAIStreamChunk> {
    const only = req.messages.length === 1 ? (req.messages[0]?.content ?? '') : '';
    if (only.startsWith(EXTRACTOR_PROMPT)) {
      this.extractorPrompts.push(only);
      if (this.failExtractor) throw new Error('extractor caído');
      const items = chunkUsers(only)
        .filter((u) => u.text.includes('dato:'))
        .map((u) => ({
          kind: 'fact',
          key: u.text.split('dato:')[1]!.split('=')[0]!.trim(),
          text: u.text.split('dato:')[1]!.trim().split(' ')[0]!,
          sources: [u.id],
        }));
      yield* makeTextRound(JSON.stringify({ items }));
      return;
    }
    if (only.startsWith(SUMMARIZER_PROMPT)) {
      this.summaryPrompts.push(only);
      const users = chunkUsers(only);
      yield* makeTextRound(
        `Resumen: ${users.length} peticiones del usuario hasta ${users.at(-1)?.id}.`,
      );
      return;
    }
    this.agentRequests.push({ ...req, messages: req.messages.map((m) => ({ ...m })) });
    yield* makeTextRound('Entendido.');
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }
}

function makeConfig(
  base: string,
  window: number,
  session: Record<string, unknown> = {},
  providers: Record<string, unknown> = {},
): StratumConfig {
  return StratumConfigSchema.parse({
    provider: {
      default: 'main',
      providers: {
        main: {
          type: 'openai-compatible',
          baseUrl: 'http://127.0.0.1:1/v1',
          apiKey: 'main-secret-key',
          model: 'main-model',
          contextWindow: window,
        },
        ...providers,
      },
    },
    memory: {
      autoExtract: false,
      projectFile: join(base, 'STRATUM.md'),
      globalFile: join(base, 'global-STRATUM.md'),
      decisionsFile: join(base, 'memory', 'decisions.json'),
      vectorDb: join(base, 'memory', 'vectors.db'),
      session,
    },
    context: { reserveOutput: 1_024 },
    skills: { enabled: false },
    trace: { enabled: false },
    tools: { auditLog: false },
  });
}

interface Rig {
  agent: StratumAgent;
  model: FakeModel;
  conversation: SessionConversation;
  config: StratumConfig;
}

function rig(
  opts: {
    base?: string;
    window?: number;
    session?: Record<string, unknown>;
    providers?: Record<string, unknown>;
    conversation?: SessionConversation;
    restore?: boolean;
    sessionId?: string;
  } = {},
): Rig {
  const base = opts.base ?? tmp();
  const config = makeConfig(base, opts.window ?? 12_000, opts.session, opts.providers);
  const router = new ProviderRouter(config);
  const model = new FakeModel();
  router.getActive = () => model;
  const sessionId = opts.sessionId ?? 'sess_20261018_m11aaa';
  const conversation =
    opts.conversation ??
    new SessionConversation({ sessionId, store: new MemoryConversationStore(sessionId) });
  const agent = new StratumAgent(config, router, new ToolRegistry(), {
    env: createSessionEnv({ cwd: base, env: {} }),
    conversation: { conversation, ...(opts.restore ? { restore: true } : {}) },
  });
  return { agent, model, conversation, config };
}

async function turn(agent: StratumAgent, input: string): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const e of agent.run(input)) events.push(e);
  return events;
}

/** Ventana con la que el system prompt de este agente cabe y sobra sitio para ~`room` tokens. */
function windowFor(room: number): number {
  const probe = rig({ window: 1_000_000 });
  const system = probe.agent.getContextReport().breakdown.system;
  // usable × 0.7 = system + room  →  window = usable + reserva
  return Math.ceil((system + room) / 0.7) + 1_024;
}

const filler = (n: number): string => `${'relleno '.repeat(n)}`.trim();

describe('M11 — tres capas separadas', () => {
  it('100 mensajes guardados, unos pocos activos: compactar no borra la conversación', async () => {
    const { agent, conversation, model } = rig({ window: windowFor(4_000) });
    for (let i = 1; i <= 50; i++) {
      await turn(agent, `turno ${i} dato: color-${i}=azul${i} ${filler(60)}`);
    }
    const stats = conversation.stats();
    expect(conversation.store.agentCount()).toBe(100);
    expect(stats.compactions).toBeGreaterThan(0);
    const active = agent.getMessages().filter((m) => m.role !== 'system').length;
    expect(active).toBeLessThan(40);
    expect(conversation.state.activeIds).toHaveLength(active);
    // Lo compactado sigue entero en el store.
    expect(conversation.store.getAgent('e1')?.message.content).toContain('turno 1 dato: color-1');
    // Y en la memoria, con procedencia que apunta a entradas reales.
    const fact = conversation.memory.items.find((i) => i.text === 'color-1=azul1');
    expect(fact?.sources).toEqual(['e1']);
    for (const item of conversation.memory.items) {
      for (const source of item.sources)
        expect(conversation.store.orderOf(source)).toBeGreaterThanOrEqual(0);
    }
    // La memoria está en el system prompt de las peticiones siguientes.
    const last = model.agentRequests.at(-1)!;
    expect(last.messages[0]!.content).toContain(SESSION_MEMORY_START);
    expect(last.messages[0]!.content).toContain('color-1=azul1');
    // Y el turno 1 ya no está literal en el contexto.
    expect(last.messages.some((m) => m.role === 'user' && m.content?.includes('turno 1 '))).toBe(
      false,
    );
  });

  it('el agente responde sobre un turno antiguo con la memoria de sesión', async () => {
    const { agent, model } = rig({ window: windowFor(3_000) });
    await turn(agent, `dato: proyecto=nombre-clave-orca ${filler(80)}`);
    for (let i = 0; i < 30; i++) await turn(agent, `otra cosa ${i} ${filler(80)}`);
    await turn(agent, '¿Cuál era el nombre clave del proyecto?');
    const ask = model.agentRequests.at(-1)!;
    const users = ask.messages.filter((m) => m.role === 'user').map((m) => m.content ?? '');
    expect(users.some((u) => u.includes('nombre-clave-orca'))).toBe(false);
    expect(ask.messages[0]!.content).toContain('proyecto=nombre-clave-orca');
  });
});

describe('M11 — fallos del modelo de memoria', () => {
  it('extractor caído: conversación intacta, memoria anterior intacta, aviso y nada quitado', async () => {
    const { agent, conversation, model } = rig({ window: windowFor(3_000) });
    for (let i = 0; i < 25; i++) await turn(agent, `uno ${i} dato: k${i}=v${i} ${filler(70)}`);
    const before = conversation.memory;
    expect(before.version).toBeGreaterThan(0);
    const beforeJson = JSON.stringify(before);
    const activeBefore = agent.getMessages().length;

    model.failExtractor = true;
    const warnings: string[] = [];
    for (let i = 0; i < 8; i++) {
      for (const e of await turn(agent, `dos ${i} ${filler(70)}`)) {
        if (e.type === 'warning') warnings.push(e.message);
      }
    }
    expect(warnings.some((w) => w.startsWith('session_memory_deferred'))).toBe(true);
    expect(JSON.stringify(conversation.memory)).toBe(beforeJson);
    // Nada se quitó: el contexto creció con los turnos nuevos.
    expect(agent.getMessages().length).toBe(activeBefore + 16);
    expect(conversation.store.agentCount()).toBe(66);
    expect(conversation.state.lastCompactionError).toMatch(/extractor caído/);

    // Al volver el modelo, se compacta lo pendiente.
    model.failExtractor = false;
    await turn(agent, `tres ${filler(70)}`);
    expect(conversation.memory.version).toBeGreaterThan(before.version);
    expect(conversation.state.lastCompactionError).toBeNull();
  });

  it('un store que falla (disco) aplaza la compactación: ni excepción ni nada quitado', async () => {
    const { agent, conversation } = rig({ window: windowFor(3_000) });
    for (let i = 0; i < 6; i++) await turn(agent, `a ${i} ${filler(70)}`);
    conversation.store.appendAgent = () => {
      throw new Error('ENOSPC');
    };
    const before = agent.getMessages().length;
    const warnings: string[] = [];
    for (let i = 0; i < 20; i++) {
      for (const e of await turn(agent, `b ${i} ${filler(70)}`)) {
        if (e.type === 'warning') warnings.push(e.message);
        expect(e.type).not.toBe('error');
      }
    }
    expect(warnings.some((w) => /session_memory_deferred: conversation store failed/.test(w))).toBe(
      true,
    );
    expect(agent.getMessages().length).toBe(before + 40);
    expect(conversation.memory.version).toBe(0);
  });

  it('si ya no cabe y no se puede compactar, error explícito y no se borra nada', async () => {
    const { agent, conversation, model } = rig({ window: windowFor(2_000) });
    model.failExtractor = true;
    let error: string | undefined;
    let stopped: string | null = null;
    for (let i = 0; i < 60 && !error; i++) {
      for (const e of await turn(agent, `turno ${i} ${filler(120)}`)) {
        if (e.type === 'error') error = e.message;
        if (e.type === 'done') stopped = e.stopReason;
      }
    }
    expect(error).toMatch(/^context_full: /);
    expect(error).toMatch(/Nothing was deleted/);
    expect(stopped).toBe('error');
    // Todo lo dicho sigue en el contexto y en el store.
    const users = agent.getMessages().filter((m) => m.role === 'user');
    expect(users[0]?.content).toContain('turno 0 ');
    expect(conversation.store.agentCount()).toBeGreaterThanOrEqual(users.length);
  });
});

describe('M11 — conversación larga', () => {
  it('cientos de turnos sin que el contexto activo crezca con ellos', async () => {
    const { agent, conversation } = rig({ window: windowFor(2_500) });
    const sizes: number[] = [];
    for (let i = 0; i < 400; i++) {
      await turn(agent, `t${i} dato: n${i}=${i} ${filler(30)}`);
      sizes.push(agent.getMessages().length);
    }
    expect(conversation.store.agentCount()).toBe(800);
    const maxLate = Math.max(...sizes.slice(200));
    const maxEarly = Math.max(...sizes.slice(0, 200));
    // Acotado: la segunda mitad no tiene más contexto activo que la primera.
    expect(maxLate).toBeLessThanOrEqual(maxEarly);
    expect(maxLate).toBeLessThan(100);
    expect(conversation.stats().compactions).toBeGreaterThan(5);
  }, 120_000);
});

describe('M11 — aislamiento', () => {
  it('lo de la sesión A no aparece en la memoria de B ni en la memoria de proyecto/global', async () => {
    const base = tmp();
    const a = rig({ base, window: windowFor(2_500), sessionId: 'sess_20261018_aaaaaa' });
    const b = rig({ base, window: windowFor(2_500), sessionId: 'sess_20261018_bbbbbb' });
    await turn(a.agent, `dato: secreto-de-a=solo-a ${filler(80)}`);
    for (let i = 0; i < 25; i++) {
      await turn(a.agent, `a ${i} ${filler(80)}`);
      await turn(b.agent, `b ${i} ${filler(80)}`);
    }
    expect(JSON.stringify(a.conversation.memory)).toContain('solo-a');
    expect(JSON.stringify(b.conversation.memory)).not.toContain('solo-a');
    for (const req of b.model.agentRequests) {
      expect(JSON.stringify(req.messages)).not.toContain('solo-a');
    }
    // Ni decisiones de proyecto ni STRATUM.md: nada se promociona solo.
    expect(existsSync(join(base, 'memory', 'decisions.json'))).toBe(false);
    expect(existsSync(join(base, 'STRATUM.md'))).toBe(false);
    expect(existsSync(join(base, 'global-STRATUM.md'))).toBe(false);
  });
});

describe('M11 — reconstrucción', () => {
  it('otro agente sobre el mismo store y estado recupera el contexto activo y la memoria', async () => {
    const first = rig({ window: windowFor(2_500) });
    for (let i = 0; i < 20; i++) await turn(first.agent, `r${i} dato: q${i}=${i} ${filler(70)}`);
    const active = first.agent.getMessages().filter((m) => m.role !== 'system');
    const reopened = new SessionConversation({
      sessionId: first.conversation.sessionId,
      store: first.conversation.store,
      memory: first.conversation.memory,
      state: first.conversation.state,
    });
    const second = rig({ window: windowFor(2_500), conversation: reopened, restore: true });
    const restored = second.agent.getMessages();
    expect(restored[0]?.role).toBe('system');
    expect(restored.slice(1)).toEqual(active);
    expect(restored[0]!.content).toContain(SESSION_MEMORY_START);
    // Lo restaurado no se vuelve a guardar.
    expect(first.conversation.store.agentCount()).toBe(40);
  });
});

// ---------------------------------------------------------------------------
// Modelo de memoria distinto, y frontera de credenciales
// ---------------------------------------------------------------------------

interface Seen {
  auth: string | undefined;
  model: string;
  prompt: string;
}

let server: Server;
let serverUrl = '';
const seen: Seen[] = [];

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const parsed = JSON.parse(body) as { model: string; messages: Array<{ content: string }> };
      const prompt = parsed.messages[0]?.content ?? '';
      seen.push({ auth: req.headers.authorization, model: parsed.model, prompt });
      const text = prompt.startsWith(EXTRACTOR_PROMPT)
        ? JSON.stringify({
            items: chunkUsers(prompt)
              .filter((u) => u.text.includes('dato:'))
              .map((u) => ({ kind: 'fact', key: 'k', text: u.text, sources: [u.id] })),
          })
        : 'Resumen remoto.';
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n`,
      );
      res.write(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`,
      );
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  serverUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

describe('M11 — modelo de memoria configurable', () => {
  it('extractor y resumen en otro provider: se usa ese modelo, con su clave y nunca la principal', async () => {
    seen.length = 0;
    const { agent, model, conversation } = rig({
      window: windowFor(2_500),
      providers: {
        small: {
          type: 'openai-compatible',
          baseUrl: serverUrl,
          apiKey: 'memory-only-key',
          model: 'qwen-small',
        },
      },
      session: {
        extractor: { provider: 'small', model: 'same' },
        summarizer: { provider: 'small', model: 'qwen-summary' },
      },
    });
    for (let i = 0; i < 25; i++) await turn(agent, `x${i} dato: z${i}=${i} ${filler(80)}`);
    expect(conversation.memory.version).toBeGreaterThan(0);
    // El modelo principal no hizo ni una llamada de memoria.
    expect(model.extractorPrompts).toHaveLength(0);
    expect(model.summaryPrompts).toHaveLength(0);
    const extractor = seen.filter((s) => s.prompt.startsWith(EXTRACTOR_PROMPT));
    const summary = seen.filter((s) => s.prompt.startsWith(SUMMARIZER_PROMPT));
    expect(extractor.length).toBeGreaterThan(0);
    expect(summary.length).toBeGreaterThan(0);
    expect(new Set(extractor.map((s) => s.model))).toEqual(new Set(['qwen-small']));
    expect(new Set(summary.map((s) => s.model))).toEqual(new Set(['qwen-summary']));
    for (const s of seen) {
      expect(s.auth).toBe('Bearer memory-only-key');
      expect(JSON.stringify(s)).not.toContain('main-secret-key');
    }
  });

  it('un provider de memoria remoto sin `allowRemote` no recibe la conversación', async () => {
    const config = makeConfig(
      tmp(),
      100_000,
      { extractor: { provider: 'cloud' } },
      {
        cloud: {
          type: 'openai-compatible',
          baseUrl: 'https://api.example.com/v1',
          apiKey: 'cloud-key',
          model: 'big',
        },
      },
    );
    const router = new ProviderRouter(config);
    const blocked = resolveMemoryModels(config, router);
    expect(blocked).toMatchObject({ ok: false, reason: 'egress' });
    expect((blocked as { message: string }).message).toMatch(/allowRemote/);

    const allowed = resolveMemoryModels(
      {
        ...config,
        memory: { ...config.memory, session: { ...config.memory.session, allowRemote: true } },
      },
      router,
    );
    expect(allowed).toMatchObject({ ok: true, extractor: { providerName: 'cloud', model: 'big' } });
    // `same` no cruza ninguna frontera nueva: es el provider de la sesión.
    expect(resolveMemoryModels(makeConfig(tmp(), 100_000), router)).toMatchObject({
      ok: true,
      extractor: { providerName: 'main', model: 'main-model', sameProvider: true },
    });
  });

  it('con el egress bloqueado no se compacta: se avisa y no se quita nada', async () => {
    const { agent, conversation } = rig({
      window: windowFor(2_500),
      session: { extractor: { provider: 'cloud' } },
      providers: {
        cloud: {
          type: 'openai-compatible',
          baseUrl: 'https://api.example.com/v1',
          apiKey: 'cloud-key',
          model: 'big',
        },
      },
    });
    const warnings: string[] = [];
    for (let i = 0; i < 25; i++) {
      for (const e of await turn(agent, `y${i} ${filler(80)}`)) {
        if (e.type === 'warning') warnings.push(e.message);
      }
    }
    expect(warnings.some((w) => /allowRemote/.test(w))).toBe(true);
    expect(conversation.memory.version).toBe(0);
    expect(agent.getMessages().filter((m) => m.role === 'user')).toHaveLength(25);
  });

  it('loopback es local', () => {
    expect(isLoopbackUrl('http://localhost:8080/v1')).toBe(true);
    expect(isLoopbackUrl('http://127.0.0.1:1/v1')).toBe(true);
    expect(isLoopbackUrl('http://[::1]:1/v1')).toBe(true);
    expect(isLoopbackUrl('https://api.openai.com/v1')).toBe(false);
    expect(isLoopbackUrl('http://192.168.1.10/v1')).toBe(false);
  });
});
