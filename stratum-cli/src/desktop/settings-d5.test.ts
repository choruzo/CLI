import { afterAll, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ConfigPanel, isSecretPath, maskSecrets, restoreSecrets } from './config-panel.js';
import { DesktopSettings } from './settings.js';
import { ConversationHost } from './conversation-host.js';
import { DesktopSessionStore } from './session-store.js';
import { buildAssistantConfig } from './assistant-runtime.js';
import { loadSharedConfig } from './main.js';
import { TurnScheduler } from './turn-scheduler.js';
import { parseInboundFrame } from './codec.js';
import {
  SECRET_PLACEHOLDER,
  type ConfigIssue,
  type ConversationOutboundFrame,
} from './protocol.js';
import { StratumConfigSchema, type StratumConfig } from '../config/schema.js';
import { ProviderRouter } from '../providers/router.js';
import { MockProvider, makeTextRound } from '../providers/mock.js';
import type { CompletionRequest, IProvider, OpenAIStreamChunk } from '../providers/base.js';

const root = mkdtempSync(join(tmpdir(), 'stratum-desktop-d5-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

let seq = 0;
function freshDir(): string {
  const dir = join(root, `t${++seq}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}
function cid(): string {
  seq++;
  return `5d5c1c0e-3d2a-4b8e-9c1d-${seq.toString(16).padStart(12, '0')}`;
}

/** Acceso libre a un JSON anidado en las aserciones. */
interface Tree {
  [key: string]: Tree;
}

const provider = (baseUrl: string, apiKey: string, model = 'm1') => ({
  type: 'openai-compatible',
  baseUrl,
  apiKey,
  model,
  contextWindow: 32768,
});

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', 'utf-8');
}

async function waitFor(pred: () => boolean, ms = 3_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('secretos enmascarados (D5)', () => {
  it('enmascara los literales y deja las referencias a la vista', () => {
    const masked = maskSecrets({
      provider: {
        providers: {
          a: provider('https://api.openai.com/v1', 'sk-literal'),
          b: provider('http://localhost:11434/v1', '${OLLAMA_KEY}'),
          c: provider('http://localhost:8080/v1', ''),
        },
      },
      tools: { webSearch: { tavilyApiKey: 'tvly-x', backend: 'meta' } },
      ssh: { hosts: { h: { password: 'env:PW', passphrase: 'literal' } } },
      mcp: {
        servers: [{ name: 's', command: 'x', env: { GITHUB_TOKEN: 'ghp_x', PLAIN: '${P}' } }],
      },
    }) as Tree;
    expect(masked.provider.providers.a.apiKey).toBe(SECRET_PLACEHOLDER);
    expect(masked.provider.providers.a.baseUrl).toBe('https://api.openai.com/v1');
    expect(masked.provider.providers.b.apiKey).toBe('${OLLAMA_KEY}');
    expect(masked.provider.providers.c.apiKey).toBe('');
    expect(masked.tools.webSearch.tavilyApiKey).toBe(SECRET_PLACEHOLDER);
    expect(masked.tools.webSearch.backend).toBe('meta');
    expect(masked.ssh.hosts.h.password).toBe('env:PW');
    expect(masked.ssh.hosts.h.passphrase).toBe(SECRET_PLACEHOLDER);
    expect(masked.mcp.servers[0].env.GITHUB_TOKEN).toBe(SECRET_PLACEHOLDER);
    expect(masked.mcp.servers[0].env.PLAIN).toBe('${P}');
    expect(isSecretPath(['mcp', 'servers', 0, 'command'])).toBe(false);
  });

  it('restaura el marcador con el valor de disco en la misma ruta', () => {
    const disk = { provider: { providers: { a: provider('https://x.test/v1', 'sk-real') } } };
    const draft = {
      provider: {
        providers: { a: { ...provider('https://x.test/v2', SECRET_PLACEHOLDER), model: 'm2' } },
      },
    };
    const issues: ConfigIssue[] = [];
    const out = restoreSecrets(draft, disk, issues) as Tree;
    expect(issues).toEqual([]);
    expect(out.provider.providers.a.apiKey).toBe('sk-real');
    expect(out.provider.providers.a.model).toBe('m2');
  });

  it('no manda una key guardada a otro servidor ni escribe el marcador literal', () => {
    const disk = {
      provider: { providers: { a: provider('https://api.openai.com/v1', 'sk-real') } },
    };
    const issues: ConfigIssue[] = [];
    const out = restoreSecrets(
      {
        provider: {
          providers: {
            a: provider('https://evil.example/v1', SECRET_PLACEHOLDER),
            nuevo: provider('https://x.test/v1', SECRET_PLACEHOLDER),
          },
        },
        agent: { maxIterations: SECRET_PLACEHOLDER },
      },
      disk,
      issues,
    ) as Tree;
    expect(out.provider.providers.a.apiKey).toBe(SECRET_PLACEHOLDER);
    expect(issues.map((i) => i.path).sort()).toEqual([
      'agent.maxIterations',
      'provider.providers.a.apiKey',
      'provider.providers.nuevo.apiKey',
    ]);
    expect(issues.find((i) => i.path === 'provider.providers.a.apiKey')?.message).toMatch(/URL/);
  });
});

describe('ConfigPanel (D5, 15.7)', () => {
  it('snapshot: JSON enmascarado, hash, capas por encima y versión más nueva', () => {
    const dir = freshDir();
    const home = join(dir, 'home');
    mkdirSync(join(home, '.stratum'), { recursive: true });
    const path = join(home, '.stratum', '.stratumrc.json');
    writeJson(path, {
      provider: { default: 'a', providers: { a: provider('https://x.test/v1', 'sk-real') } },
    });
    const panel = new ConfigPanel(path, home);
    let snap = panel.snapshot();
    expect(snap.exists).toBe(true);
    expect(snap.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(snap.text).not.toContain('sk-real');
    expect(snap.text).toContain(SECRET_PLACEHOLDER);
    expect(snap.overrides).toEqual([]);
    expect(snap.readOnly).toBeNull();

    writeJson(join(home, '.stratumrc.json'), { agent: { maxIterations: 3 } });
    expect(panel.snapshot().overrides).toEqual([join(home, '.stratumrc.json')]);

    writeJson(path, { schemaVersion: 99 });
    expect(panel.snapshot().readOnly).toMatch(/más nueva/);
    expect(panel.save('{}', panel.snapshot().hash).kind).toBe('read_only');

    writeFileSync(path, '{ "agent": ', 'utf-8');
    snap = panel.snapshot();
    expect(snap.parseError).toMatch(/JSON no válido/);
    expect(snap.text).toBe('{ "agent": ');
  });

  it('valida con línea y columna para la sintaxis y con ruta para el schema', () => {
    const dir = freshDir();
    const panel = new ConfigPanel(join(dir, '.stratumrc.json'), dir);
    const syntax = panel.validate('{\n  "agent": {\n    "maxIterations": 5,\n  }\n}');
    expect(syntax.issues).toHaveLength(1);
    expect(syntax.issues[0].path).toBe('');
    expect(syntax.issues[0].line).toBe(4);
    const schema = panel.validate(JSON.stringify({ agent: { maxIterations: -1 } }));
    expect(schema.issues.map((i) => i.path)).toEqual(['agent.maxIterations']);
    expect(panel.validate('[]').issues[0].message).toMatch(/objeto/);

    // Como el loader: `${VAR}` se expande antes de validar la URL.
    process.env.STRATUM_D5_TEST_URL = 'http://localhost:9/v1';
    const env = panel.validate(
      JSON.stringify({
        provider: { default: 'a', providers: { a: provider('${STRATUM_D5_TEST_URL}', '') } },
      }),
    );
    expect(env.issues).toEqual([]);
    delete process.env.STRATUM_D5_TEST_URL;
  });

  it('guarda sobre el hash leído: conflicto si cambió, sobrescribe con force', () => {
    const dir = freshDir();
    const path = join(dir, '.stratumrc.json');
    writeJson(path, {
      provider: { default: 'a', providers: { a: provider('https://x.test/v1', 'sk-real') } },
    });
    const panel = new ConfigPanel(path, dir);
    const snap = panel.snapshot();
    const draft = JSON.parse(snap.text);
    draft.provider.providers.a.model = 'm2';

    // La CLI escribe entretanto.
    writeJson(path, {
      provider: { default: 'a', providers: { a: provider('https://x.test/v1', 'sk-real', 'cli') } },
    });
    expect(panel.save(JSON.stringify(draft), snap.hash).kind).toBe('conflict');
    expect(JSON.parse(readFileSync(path, 'utf-8')).provider.providers.a.model).toBe('cli');

    const forced = panel.save(JSON.stringify(draft), snap.hash, true);
    expect(forced.kind).toBe('saved');
    const onDisk = JSON.parse(readFileSync(path, 'utf-8'));
    expect(onDisk.provider.providers.a.model).toBe('m2');
    // La key real vuelve a disco; el marcador no se escribe nunca.
    expect(onDisk.provider.providers.a.apiKey).toBe('sk-real');
    expect(existsSync(`${path}.bak`)).toBe(true);

    const invalid = panel.save(
      JSON.stringify({ agent: { maxIterations: 0 } }),
      panel.snapshot().hash,
    );
    expect(invalid.kind).toBe('invalid');
    expect(JSON.parse(readFileSync(path, 'utf-8')).provider.providers.a.model).toBe('m2');
  });

  it('crea el fichero si no existía (baseHash null)', () => {
    const dir = freshDir();
    const path = join(dir, 'sub', '.stratumrc.json');
    const panel = new ConfigPanel(path, dir);
    expect(panel.snapshot()).toMatchObject({ exists: false, hash: null, text: '' });
    const saved = panel.save(
      JSON.stringify({
        provider: { default: 'a', providers: { a: provider('http://localhost:8080/v1', '') } },
      }),
      null,
    );
    expect(saved.kind).toBe('saved');
    expect(existsSync(path)).toBe(true);
  });

  it('el watcher avisa de un cambio externo una vez y nunca de una escritura propia', async () => {
    const dir = freshDir();
    const path = join(dir, '.stratumrc.json');
    writeJson(path, { agent: { maxIterations: 5 } });
    const panel = new ConfigPanel(path, dir);
    const onChange = vi.fn();
    const stop = panel.watch(onChange, 60);
    try {
      // Propia: no vuelve como cambio externo.
      expect(
        panel.save(JSON.stringify({ agent: { maxIterations: 6 } }), panel.snapshot().hash).kind,
      ).toBe('saved');
      await new Promise((r) => setTimeout(r, 300));
      expect(onChange).not.toHaveBeenCalled();

      // Externa, en dos escrituras seguidas (un editor): un solo aviso.
      writeJson(path, { agent: { maxIterations: 7 } });
      writeJson(path, { agent: { maxIterations: 8 } });
      await waitFor(() => onChange.mock.calls.length > 0);
      await new Promise((r) => setTimeout(r, 300));
      expect(onChange).toHaveBeenCalledTimes(1);

      // Reescribir el mismo contenido no es un cambio.
      writeJson(path, { agent: { maxIterations: 8 } });
      await new Promise((r) => setTimeout(r, 300));
      expect(onChange).toHaveBeenCalledTimes(1);
    } finally {
      stop();
    }
  });
});

describe('DesktopSettings (D5)', () => {
  function setupSettings(initial?: unknown) {
    const dir = freshDir();
    const home = join(dir, 'home');
    mkdirSync(join(home, '.stratum'), { recursive: true });
    const path = join(home, '.stratum', '.stratumrc.json');
    if (initial !== undefined) writeJson(path, initial);
    const panel = new ConfigPanel(path, home);
    const frames: ConversationOutboundFrame[] = [];
    const applied: StratumConfig[] = [];
    const probe = vi.fn(async (_url: string, _key: string) => ['m1', 'm2']);
    const load = () => {
      try {
        const raw = existsSync(path) ? JSON.parse(readFileSync(path, 'utf-8')) : {};
        return { config: StratumConfigSchema.parse(raw), error: null };
      } catch (err) {
        return {
          config: StratumConfigSchema.parse({}),
          error: {
            type: 'sidecar_error' as const,
            fatal: true,
            code: 'config_invalid' as const,
            message: String(err),
          },
        };
      }
    };
    const settings = new DesktopSettings({
      panel,
      load,
      apply: (c) => applied.push(c),
      startup: load().config,
      dataDir: join(dir, 'data'),
      probe,
      debounceMs: 50,
    });
    settings.attach((f) => frames.push(f));
    return { dir, path, panel, frames, applied, probe, settings };
  }

  it('guardar responde config_saved + config_state y aplica la config', async () => {
    const t = setupSettings({ agent: { maxIterations: 5 } });
    await t.settings.handle({ type: 'config_get' });
    const state = t.frames.find((f) => f.type === 'config_state');
    if (state?.type !== 'config_state') throw new Error('sin estado');
    expect(state.reason).toBe('requested');
    expect(state.defaults).toHaveProperty('agent');

    await t.settings.handle({
      type: 'config_save',
      text: JSON.stringify({ agent: { maxIterations: 9 } }),
      baseHash: state.snapshot.hash,
    });
    expect(t.frames.map((f) => f.type)).toEqual(['config_state', 'config_saved', 'config_state']);
    expect(t.applied.at(-1)?.agent.maxIterations).toBe(9);
    const after = t.frames.at(-1);
    expect(after?.type === 'config_state' && after.reason).toBe('saved');
    expect(after?.type === 'config_state' && after.applied).toEqual({
      ok: true,
      error: null,
      restartRequired: [],
      os: {
        notifications: { enabled: true, minSeconds: 10 },
        globalHotkey: 'CommandOrControl+Shift+Space',
        updates: { autoCheck: true },
      },
      providerReady: false,
    });
  });

  it('conflicto e inválido no escriben; validación en vivo por requestId', async () => {
    const t = setupSettings({ agent: { maxIterations: 5 } });
    await t.settings.handle({ type: 'config_save', text: '{}', baseHash: 'f'.repeat(64) });
    expect(t.frames.at(-1)?.type).toBe('config_conflict');
    await t.settings.handle({
      type: 'config_save',
      text: '{"agent":{"maxIterations":"x"}}',
      baseHash: t.panel.snapshot().hash,
    });
    expect(t.frames.at(-1)?.type).toBe('config_invalid');
    await t.settings.handle({ type: 'config_validate', requestId: 'r1', text: '{"agent":' });
    const v = t.frames.at(-1);
    expect(v?.type === 'config_validation' && v.requestId).toBe('r1');
    expect(v?.type === 'config_validation' && v.issues[0].line).toBe(1);
    expect(t.applied).toHaveLength(0);
  });

  it('un cambio externo inválido deja la config anterior y lo dice', async () => {
    const t = setupSettings({ agent: { maxIterations: 5 } });
    t.settings.start();
    try {
      writeJson(t.path, { agent: { maxIterations: -3 } });
      await waitFor(() => t.frames.some((f) => f.type === 'config_state'));
      const state = t.frames.find((f) => f.type === 'config_state');
      expect(state?.type === 'config_state' && state.reason).toBe('external');
      expect(state?.type === 'config_state' && state.applied.ok).toBe(false);
      expect(t.applied).toHaveLength(0);
    } finally {
      t.settings.stop();
    }
  });

  it('marca como pendiente de reinicio la raíz de los workspaces y el logging', async () => {
    const t = setupSettings({});
    await t.settings.handle({
      type: 'config_save',
      text: JSON.stringify({
        desktop: { workspaces: { root: join(t.dir, 'ws'), compressAfterDays: 2 } },
        logging: { level: 'debug' },
      }),
      baseHash: t.panel.snapshot().hash,
    });
    const state = t.frames.at(-1);
    expect(state?.type === 'config_state' && state.applied.restartRequired).toEqual([
      'Carpeta de los espacios de trabajo',
      'Registro (logging)',
    ]);
  });

  it('el sondeo usa la key guardada solo contra su mismo servidor', async () => {
    const t = setupSettings({
      provider: { default: 'a', providers: { a: provider('https://api.test/v1', 'sk-real') } },
    });
    await t.settings.handle({
      type: 'provider_probe',
      requestId: 'p1',
      baseUrl: 'https://api.test/v1',
      apiKey: SECRET_PLACEHOLDER,
      provider: 'a',
    });
    expect(t.probe).toHaveBeenLastCalledWith('https://api.test/v1', 'sk-real');
    expect(t.frames.at(-1)).toEqual({
      type: 'provider_probe_result',
      requestId: 'p1',
      models: ['m1', 'm2'],
    });

    await t.settings.handle({
      type: 'provider_probe',
      requestId: 'p2',
      baseUrl: 'https://evil.example/v1',
      provider: 'a',
    });
    expect(t.probe).toHaveBeenCalledTimes(1);
    const r = t.frames.at(-1);
    expect(r?.type === 'provider_probe_result' && r.error).toMatch(/otro servidor/);

    await t.settings.handle({
      type: 'provider_probe',
      requestId: 'p3',
      baseUrl: 'file:///etc/passwd',
    });
    const f = t.frames.at(-1);
    expect(f?.type === 'provider_probe_result' && f.error).toMatch(/http/);

    await t.settings.handle({
      type: 'provider_probe',
      requestId: 'p4',
      baseUrl: 'https://otro.test/v1',
      apiKey: 'sk-tecleada',
    });
    expect(t.probe).toHaveBeenLastCalledWith('https://otro.test/v1', 'sk-tecleada');
  });
});

// ---------------------------------------------------------------------------
// Aplicar la config a las conversaciones
// ---------------------------------------------------------------------------

class GatedProvider implements IProvider {
  private opened!: () => void;
  readonly gate = new Promise<void>((r) => (this.opened = r));
  open(): void {
    this.opened();
  }
  async *complete(req: CompletionRequest): AsyncGenerator<OpenAIStreamChunk> {
    await Promise.race([
      this.gate,
      new Promise<void>((r) => req.signal?.addEventListener('abort', () => r(), { once: true })),
    ]);
    yield {
      choices: [{ delta: { content: 'ok' }, finish_reason: 'stop', index: 0 }],
    } as OpenAIStreamChunk;
  }
  async healthCheck(): Promise<boolean> {
    return true;
  }
}

function assistantConfig(dir: string, providers: Record<string, unknown>, def: string) {
  return buildAssistantConfig(
    StratumConfigSchema.parse({
      provider: { default: def, providers },
      memory: { globalFile: join(dir, 'STRATUM.md'), autoExtract: false },
    }),
    join(dir, 'data'),
  );
}

function setupHost(opts: { provider?: () => IProvider; startupError?: boolean } = {}) {
  const dir = freshDir();
  const config = assistantConfig(dir, { a: provider('http://127.0.0.1:1/v1', '', 'model-a') }, 'a');
  const frames: ConversationOutboundFrame[] = [];
  const host = new ConversationHost({
    config,
    store: new DesktopSessionStore(join(dir, 'sessions')),
    startupError: opts.startupError
      ? { type: 'sidecar_error', fatal: true, code: 'config_invalid', message: 'rota' }
      : null,
    makeRouter: (current) => {
      const router = new ProviderRouter(current);
      vi.spyOn(router, 'getActive').mockReturnValue(
        opts.provider?.() ?? new MockProvider([makeTextRound('ok')]),
      );
      return router;
    },
  });
  host.attach(1, (f) => frames.push(f));
  const wait = async (pred: () => boolean) => {
    await host.idle();
    await waitFor(pred);
  };
  const statsOf = (id: string) =>
    frames.flatMap((f) =>
      (f.type === 'conversation_stats' && f.conversationId === id) ||
      (f.type === 'conversation_opened' && f.conversationId === id)
        ? [f.stats]
        : [],
    );
  return { dir, config, frames, host, wait, statsOf };
}

describe('ConversationHost.applyConfig (D5)', () => {
  it('una conversación sin turno cambia de provider en el acto', async () => {
    const t = setupHost();
    const id = cid();
    t.host.handle({ type: 'new_conversation', conversationId: id }, 1);
    await t.wait(() => t.frames.some((f) => f.type === 'conversation_opened'));
    expect(t.statsOf(id).at(-1)?.provider).toBe('a');

    t.host.applyConfig(
      assistantConfig(t.dir, { b: provider('http://127.0.0.1:2/v1', '', 'model-b') }, 'b'),
    );
    expect(t.statsOf(id).at(-1)).toMatchObject({ provider: 'b', model: 'model-b' });
  });

  it('con un turno en marcha espera al siguiente, y el modelo de /model se conserva', async () => {
    const gated: GatedProvider[] = [];
    const t = setupHost({
      provider: () => {
        const p = new GatedProvider();
        gated.push(p);
        return p;
      },
    });
    const id = cid();
    t.host.handle({ type: 'new_conversation', conversationId: id }, 1);
    await t.wait(() => t.frames.some((f) => f.type === 'conversation_opened'));
    t.host.handle({ type: 'set_model', conversationId: id, model: 'elegido' }, 1);
    t.host.handle({ type: 'chat', conversationId: id, turnId: 't1', text: 'hola' }, 1);
    await t.wait(() => t.frames.some((f) => f.type === 'turn_started'));

    // Mismo provider con otro modelo por defecto y una URL nueva.
    t.host.applyConfig(
      assistantConfig(t.dir, { a: provider('http://127.0.0.1:3/v1', '', 'nuevo-default') }, 'a'),
    );
    gated[0].open();
    await t.wait(() => t.frames.some((f) => f.type === 'turn_ended' && f.turnId === 't1'));
    // El turno terminó con el router de antes.
    expect(gated).toHaveLength(1);

    t.host.handle({ type: 'chat', conversationId: id, turnId: 't2', text: 'otra' }, 1);
    await t.wait(() => gated.length === 2);
    gated[1].open();
    await t.wait(() => t.frames.some((f) => f.type === 'turn_ended' && f.turnId === 't2'));
    expect(t.statsOf(id).at(-1)).toMatchObject({ provider: 'a', model: 'elegido' });
  });

  it('una conversación que no eligió modelo sigue al nuevo por defecto', async () => {
    const t = setupHost();
    const id = cid();
    t.host.handle({ type: 'new_conversation', conversationId: id }, 1);
    await t.wait(() => t.frames.some((f) => f.type === 'conversation_opened'));
    t.host.applyConfig(
      assistantConfig(t.dir, { a: provider('http://127.0.0.1:1/v1', '', 'nuevo-default') }, 'a'),
    );
    expect(t.statsOf(id).at(-1)).toMatchObject({ provider: 'a', model: 'nuevo-default' });
  });

  it('una config que carga retira el error de arranque: se puede chatear sin reiniciar', async () => {
    const t = setupHost({ startupError: true });
    const id = cid();
    t.host.handle({ type: 'new_conversation', conversationId: id }, 1);
    await t.wait(() => t.frames.some((f) => f.type === 'conversation_error'));
    expect(t.host.startupError?.code).toBe('config_invalid');

    t.host.applyConfig(t.config);
    expect(t.host.startupError).toBeNull();
    t.host.handle({ type: 'new_conversation', conversationId: id }, 1);
    await t.wait(() => t.frames.some((f) => f.type === 'conversation_opened'));
    t.host.handle({ type: 'chat', conversationId: id, turnId: 't1', text: 'hola' }, 1);
    await t.wait(() => t.frames.some((f) => f.type === 'turn_ended'));
    expect(t.frames.some((f) => f.type === 'chat_rejected')).toBe(false);
  });

  it('las tramas de ajustes sin panel se contestan con config_error', async () => {
    const t = setupHost();
    t.host.handle({ type: 'config_get' }, 1);
    await t.wait(() => t.frames.some((f) => f.type === 'config_error'));
  });
});

describe('TurnScheduler.setLimit (D5)', () => {
  it('subir el límite arranca ya a los que esperaban', async () => {
    const s = new TurnScheduler(1);
    const a = s.acquire();
    const b = s.acquire();
    expect(b.position).toBe(1);
    let started = false;
    void b.ready.then(() => (started = true));
    s.setLimit(2);
    await Promise.resolve();
    expect(started).toBe(true);
    expect(s.active).toBe(2);
    a.release();
    b.release();
    expect(() => s.setLimit(0)).toThrow();
  });
});

describe('codec de las tramas de ajustes (D5)', () => {
  it('acepta las tramas nuevas y rechaza campos o hashes mal formados', () => {
    expect(parseInboundFrame('{"type":"config_get"}')).toEqual({ type: 'config_get' });
    expect(
      parseInboundFrame(JSON.stringify({ type: 'config_save', text: '{}', baseHash: null })),
    ).not.toBeNull();
    expect(
      parseInboundFrame(JSON.stringify({ type: 'config_save', text: '{}', baseHash: 'abc' })),
    ).toBeNull();
    expect(
      parseInboundFrame(JSON.stringify({ type: 'config_get', path: '/etc/passwd' })),
    ).toBeNull();
    expect(
      parseInboundFrame(
        JSON.stringify({ type: 'provider_probe', requestId: 'r', baseUrl: 'http://x/v1' }),
      ),
    ).not.toBeNull();
    expect(parseInboundFrame('{"type":"retention_run"}')).not.toBeNull();
    expect(parseInboundFrame('{"type":"workspaces_usage_get"}')).not.toBeNull();
  });
});

describe('loadSharedConfig tras un arreglo (D5)', () => {
  it('se puede volver a cargar desde el home sin reiniciar', () => {
    const dir = freshDir();
    writeFileSync(join(dir, '.stratumrc.json'), '{"agent": {"maxIterations": 0}}', 'utf-8');
    expect(loadSharedConfig(dir).error?.code).toBe('config_invalid');
    writeJson(join(dir, '.stratumrc.json'), { agent: { maxIterations: 4 } });
    const fixed = loadSharedConfig(dir);
    expect(fixed.error).toBeNull();
    expect(fixed.config.agent.maxIterations).toBe(4);
  });
});
