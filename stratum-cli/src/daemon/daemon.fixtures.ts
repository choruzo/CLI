/**
 * Arnés de los tests de integración del daemon: un `Stratumd` de verdad sobre un
 * pipe real, clientes de verdad (`StratumClient`) y sesiones de verdad
 * (`SessionHost`, tools, jobs). Lo único de guion es el modelo.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { StratumClient } from '../client/client.js';
import { socketConnector, type Connection, type Connector } from '../client/connection.js';
import { fileDiscovery } from '../client/discovery.js';
import { StratumConfigSchema, type StratumConfig } from '../config/schema.js';
import type { SessionStartupOptions } from '../host/session-startup.js';
import type { CompletionRequest, IProvider, OpenAIStreamChunk } from '../providers/base.js';
import { makeTextRound } from '../providers/mock.js';
import { EXTRACTOR_PROMPT, SUMMARIZER_PROMPT } from '../conversation/extract.js';
import { ProviderRouter } from '../providers/router.js';
import type {
  ProtocolEvent,
  ProtocolSessionSnapshot,
  ProtocolStateEvent,
  Role,
} from '../protocol/index.js';
import { prepareHandoff, SessionOwnership } from '../host/handoff.js';
import {
  PeerHostBridge,
  type DetachOutcome,
  type PeerHostBridgeOptions,
} from '../host/peer-host-bridge.js';
import { SessionHost, type HostGates, type SessionHostOptions } from '../host/session-host.js';
import { createSessionEnv } from '../runtime/session-env.js';
import { approverAuthFromKey } from './approver-key.js';
import { Stratumd, type StratumdOptions } from './daemon.js';

/** Clave de aprobador del daemon de pruebas. `connect(['approver'])` la presenta sola. */
export const TEST_APPROVER_KEY = 'clave de aprobador de pruebas';

/** Una ronda del modelo: sus chunks, o una espera antes de darlos. */
export type Round = OpenAIStreamChunk[] | { wait: Promise<unknown>; then: OpenAIStreamChunk[] };

/** Texto en varios fragmentos, como llega de un modelo en streaming. */
export function textRound(parts: string[]): OpenAIStreamChunk[] {
  const [first, ...rest] = parts;
  const round = makeTextRound(first ?? '');
  const end = round.pop()!;
  for (const part of rest) round.push(makeTextRound(part)[0]!);
  round.push(end);
  return round;
}

/** Respuesta del modelo de memoria de sesión (M11) a una petición, o un fallo. */
export type MemoryReply = (prompt: string) => string | Error;

/**
 * Modelo de guion: una ronda por petición del agente, en orden. Atiende la
 * cancelación. Las llamadas de la memoria de sesión (M11: extractor y resumen)
 * **no** consumen rondas: las contesta `memory` (por defecto, nada que extraer
 * y un resumen fijo) y quedan en `memoryPrompts`.
 */
export class ScriptedProvider implements IProvider {
  calls = 0;
  /** Textos de usuario que traía cada petición: lo que el modelo tenía de contexto. */
  readonly userInputs: string[][] = [];
  /** System prompt de cada petición del agente. */
  readonly systemPrompts: string[] = [];
  /** Peticiones del extractor y del resumen de la memoria de sesión. */
  readonly memoryPrompts: Array<{ role: 'extractor' | 'summarizer'; prompt: string }> = [];
  memory: { extractor: MemoryReply; summarizer: MemoryReply } = {
    extractor: () => '{"items":[]}',
    summarizer: () => 'Resumen de la conversación.',
  };

  constructor(private readonly rounds: Round[]) {}

  async *complete(req: CompletionRequest): AsyncGenerator<OpenAIStreamChunk> {
    const only = req.messages.length === 1 ? req.messages[0]?.content : undefined;
    const role =
      typeof only === 'string' && only.startsWith(EXTRACTOR_PROMPT)
        ? 'extractor'
        : typeof only === 'string' && only.startsWith(SUMMARIZER_PROMPT)
          ? 'summarizer'
          : null;
    if (role && typeof only === 'string') {
      this.memoryPrompts.push({ role, prompt: only });
      const reply = this.memory[role](only);
      if (reply instanceof Error) throw reply;
      for (const chunk of makeTextRound(reply)) yield chunk;
      return;
    }
    const system = req.messages[0];
    this.systemPrompts.push(system?.role === 'system' ? (system.content ?? '') : '');
    this.userInputs.push(
      req.messages.flatMap((m) =>
        m.role === 'user' && typeof m.content === 'string' ? [m.content] : [],
      ),
    );
    const round = this.rounds[this.calls++] ?? makeTextRound('(fin del guion)');
    let chunks: OpenAIStreamChunk[];
    if (Array.isArray(round)) chunks = round;
    else {
      // Espera a que el test la suelte, o a que cancelen el turno.
      await Promise.race([
        round.wait,
        new Promise<void>((resolve) => {
          if (req.signal?.aborted) resolve();
          else req.signal?.addEventListener('abort', () => resolve(), { once: true });
        }),
      ]);
      if (req.signal?.aborted) return;
      chunks = round.then;
    }
    for (const chunk of chunks) {
      // Una vuelta por fragmento: así el texto llega troceado de verdad.
      await new Promise((r) => setImmediate(r));
      yield chunk;
    }
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }
}

export interface Gate {
  wait: Promise<void>;
  open: () => void;
}

export function gate(): Gate {
  let open!: () => void;
  const wait = new Promise<void>((r) => (open = r));
  return { wait, open };
}

export interface TestDaemon {
  daemon: Stratumd;
  /** Carpeta temporal de todo el test. */
  base: string;
  /** Carpeta del endpoint. */
  dir: string;
  /** Veces que se llamó al cierre global del proceso. */
  teardowns: () => number;
  /** Crea un proyecto (un directorio) y fija el guion del modelo de sus sesiones. */
  project(name: string, rounds: Round[], config?: Record<string, unknown>): string;
  provider(cwd: string): ScriptedProvider;
  /**
   * Conecta un cliente. Quien pide `approver` presenta la clave de pruebas;
   * `approverKey: null` la omite, y una cadena presenta esa otra.
   */
  connect(
    roles: Role[],
    name?: string,
    options?: { approverKey?: string | null },
  ): Promise<StratumClient>;
  stop(): Promise<void>;
}

let configs = 0;

/** Config de un test: provider de guion y nada del usuario (memoria, auditoría, traza). */
export function testConfig(base: string, extra: Record<string, unknown> = {}): StratumConfig {
  return StratumConfigSchema.parse({
    provider: {
      default: 'test',
      providers: {
        test: {
          type: 'openai-compatible',
          baseUrl: 'http://127.0.0.1:1/v1',
          apiKey: '',
          model: 'test-model',
          contextWindow: 1_000_000,
        },
      },
    },
    // Nada de la memoria ni de la auditoría del usuario: todo en la carpeta del test.
    memory: {
      autoExtract: false,
      decisionsFile: join(base, 'memory', 'decisions.json'),
      vectorDb: join(base, 'memory', 'vectors.db'),
    },
    skills: { enabled: false },
    tools: { auditLog: join(base, `audit-${++configs}.jsonl`) },
    trace: { enabled: false },
    ...extra,
  });
}

/** Una sesión de la CLI de verdad, en este proceso, publicada por su puente. */
export interface TestPeer {
  host: SessionHost;
  bridge: PeerHostBridge;
  provider: ScriptedProvider;
  sessionId: string;
  /** Propiedad de la sesión en este «proceso» (M10): cierra los turnos durante un traspaso. */
  ownership: SessionOwnership;
  /** Veces que el puente avisó de que la sesión pasó al daemon. */
  handedOff: () => number;
  /** Un turno completo, como lo consume `stratum run`. Devuelve el texto y el motivo de parada. */
  run(input: string): Promise<{ text: string; stopReason: string | null }>;
  /** Traspasa la sesión al daemon, como `/detach` en `stratum chat`. */
  detach(): Promise<DetachOutcome>;
  /** Cierre normal: estado final, baja y desmontaje. */
  stop(): Promise<void>;
}

/**
 * Monta una sesión como lo hace `stratum run` —`SessionHost` + `PeerHostBridge`—
 * y la publica en el daemon que haya en `dir` (o en ninguno).
 */
export async function startPeer(
  where: { base: string; dir: string },
  name: string,
  rounds: Round[],
  bridgeOptions: Partial<PeerHostBridgeOptions> = {},
  hostOptions: {
    /** Prompts locales de la sesión, como la terminal de `stratum run`. */
    gates?: HostGates;
    destructivePolicy?: SessionHostOptions['destructivePolicy'];
    interactionTimeoutMs?: number;
    config?: Record<string, unknown>;
    /** Sin traspaso, como `stratum run`. */
    noHandoff?: boolean;
  } = {},
): Promise<TestPeer> {
  const cwd = join(where.base, name);
  mkdirSync(cwd, { recursive: true });
  const config = testConfig(where.base, hostOptions.config);
  const router = new ProviderRouter(config);
  const provider = new ScriptedProvider(rounds);
  router.getActive = () => provider;
  // Como `stratum run`: lo que pida la sesión lo puede contestar su prompt
  // local o, si el daemon acredita aprobadores, un cliente remoto.
  const link: { bridge?: PeerHostBridge } = {};
  const host = await SessionHost.create({
    env: createSessionEnv({ cwd, env: { ...process.env } }),
    config,
    router,
    mcp: 'none',
    destructivePolicy: hostOptions.destructivePolicy ?? 'deny',
    remoteApprovals: () => link.bridge?.remoteApprovals ?? false,
    ...(hostOptions.gates ? { gates: hostOptions.gates } : {}),
    ...(hostOptions.interactionTimeoutMs
      ? { interactionTimeoutMs: hostOptions.interactionTimeoutMs }
      : {}),
  });
  const ownership = new SessionOwnership();
  let handedOff = 0;
  const bridge = new PeerHostBridge({
    session: host,
    control: {
      cancel: () => host.cancel(),
      steer: (text) => host.steer(text),
      pause: () => host.pause(),
      resume: () => host.resume(),
      ...(hostOptions.noHandoff
        ? {}
        : {
            prepareHandoff: () =>
              prepareHandoff(host, ownership, async () => {
                await host.trace?.flush();
              }),
          }),
    },
    name: 'test-peer',
    version: '0.0.0-test',
    discovery: fileDiscovery({ dir: where.dir }),
    retry: { initialMs: 25, maxMs: 100, jitter: 0 },
    onHandedOff: () => {
      handedOff++;
      ownership.completeHandoff();
    },
    ...bridgeOptions,
  });
  link.bridge = bridge;
  await bridge.start();
  return {
    host,
    bridge,
    provider,
    sessionId: host.sessionId,
    ownership,
    handedOff: () => handedOff,
    async run(input) {
      const end = ownership.tryBeginTurn();
      if (!end) throw new Error(`the session is ${ownership.state}: no turns here`);
      try {
        bridge.expectRun({ input });
        let text = '';
        let stopReason: string | null = null;
        for await (const event of host.run(input)) {
          if (event.type === 'text_delta') text += event.delta;
          if (event.type === 'done') stopReason = event.stopReason;
        }
        return { text, stopReason };
      } finally {
        end();
      }
    },
    detach: () => bridge.detach(),
    async stop() {
      await host.dispose({ cancelBackground: true });
      await bridge.close();
    },
  };
}

export async function startTestDaemon(
  options: Partial<StratumdOptions> & {
    base?: string;
    /** Retiene el arranque de cada sesión (también la que llega por traspaso). */
    holdStartup?: (cwd: string) => Promise<void>;
  } = {},
): Promise<TestDaemon> {
  const ownBase = options.base === undefined;
  const base = options.base ?? realpathSync(mkdtempSync(join(tmpdir(), 'stratumd-')));
  const dir = options.dir ?? join(base, 'daemon');
  const scripts = new Map<string, { rounds: Round[]; config: Record<string, unknown> }>();
  const providers = new Map<string, ScriptedProvider>();
  const clients: StratumClient[] = [];
  let teardowns = 0;

  const configFor = (extra: Record<string, unknown> = {}): StratumConfig => testConfig(base, extra);

  const { base: _base, holdStartup, ...daemonOptions } = options;
  void _base;
  const daemon = await Stratumd.start({
    version: '0.0.0-test',
    config: configFor(),
    approver: await approverAuthFromKey(TEST_APPROVER_KEY),
    // Sin el retraso de una clave errónea: lo prueba su propio test.
    approverFailureDelayMs: 0,
    env: { ...process.env, STRATUMD_TEST: 'daemon-env' },
    dir,
    processTeardown: async () => {
      teardowns++;
    },
    startup: async (opts: SessionStartupOptions) => {
      await holdStartup?.(opts.cwd);
      const script = scripts.get(opts.cwd);
      if (!script) return { ok: false, stage: 'config', error: 'no script for that directory' };
      const config = configFor(script.config);
      const router = new ProviderRouter(config, opts.provider);
      const provider = new ScriptedProvider(script.rounds);
      providers.set(opts.cwd, provider);
      router.getActive = () => provider;
      return { ok: true, config, router };
    },
    ...daemonOptions,
  });

  return {
    daemon,
    base,
    dir,
    teardowns: () => teardowns,
    project(name, rounds, config = {}) {
      const cwd = join(base, name);
      mkdirSync(cwd, { recursive: true });
      scripts.set(cwd, { rounds, config });
      return cwd;
    },
    provider: (cwd) => providers.get(cwd)!,
    async connect(roles, name = 'test-client', connectOptions = {}) {
      const approverKey =
        connectOptions.approverKey === undefined
          ? roles.includes('approver')
            ? TEST_APPROVER_KEY
            : undefined
          : (connectOptions.approverKey ?? undefined);
      const client = new StratumClient({
        discovery: fileDiscovery({ dir }),
        identity: {
          kind: 'cli',
          name,
          version: '0.0.0-test',
          roles,
          ...(approverKey !== undefined ? { approverKey } : {}),
        },
        reconnect: false,
        requestTimeoutMs: 20_000,
      });
      await client.connect();
      clients.push(client);
      return client;
    },
    async stop() {
      for (const client of clients.splice(0)) client.close();
      await daemon.shutdown();
      if (ownBase) rmSync(base, { recursive: true, force: true });
    },
  };
}

/** Lo que un cliente va viendo de una sesión. */
export interface Watcher {
  events: ProtocolEvent[];
  snapshots: ProtocolSessionSnapshot[];
  /** Eventos de estado, en orden. */
  states(): ProtocolStateEvent[];
  seqs(): number[];
  types(): string[];
  /** Espera a que llegue un evento que cumpla la condición. */
  until(match: (event: ProtocolEvent) => boolean, timeoutMs?: number): Promise<ProtocolEvent>;
  untilSnapshot(count?: number, timeoutMs?: number): Promise<ProtocolSessionSnapshot>;
  close(): void;
}

export function watch(
  client: StratumClient,
  sessionId: string,
  options: { volatile?: boolean; sinceSeq?: number } = {},
): Watcher {
  const events: ProtocolEvent[] = [];
  const snapshots: ProtocolSessionSnapshot[] = [];
  const waiters = new Set<() => void>();
  const wake = (): void => {
    for (const w of [...waiters]) w();
  };
  const subscription = client.subscribeSession(
    sessionId,
    {
      onSnapshot: (s) => {
        snapshots.push(s);
        wake();
      },
      onEvent: (e) => {
        events.push(e);
        wake();
      },
      onError: (err) => {
        throw err;
      },
    },
    options,
  );

  const waitFor = <T>(probe: () => T | undefined, what: string, timeoutMs: number): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const check = (): void => {
        const hit = probe();
        if (hit === undefined) return;
        clearTimeout(timer);
        waiters.delete(check);
        resolve(hit);
      };
      const timer = setTimeout(() => {
        waiters.delete(check);
        reject(
          new Error(`timeout waiting for ${what}; saw: ${events.map((e) => e.type).join(' ')}`),
        );
      }, timeoutMs);
      waiters.add(check);
      check();
    });

  const states = (): ProtocolStateEvent[] =>
    events.filter((e): e is ProtocolStateEvent => 'seq' in e);
  return {
    events,
    snapshots,
    states,
    seqs: () => states().map((e) => e.seq),
    types: () => states().map((e) => e.type),
    until: (match, timeoutMs = 15_000) => waitFor(() => events.find(match), 'event', timeoutMs),
    untilSnapshot: (count = 1, timeoutMs = 15_000) =>
      waitFor(
        () => (snapshots.length >= count ? snapshots[count - 1] : undefined),
        `snapshot #${count}`,
        timeoutMs,
      ),
    close: () => subscription.close(),
  };
}

/**
 * Un conector que el test puede cortar, como si el proceso par perdiese el
 * canal: `cut()` cierra todas sus conexiones; `cutAfter(method)` cierra en
 * cuanto sale una petición de ese método (su respuesta ya no llega).
 */
export function cuttableConnector(): {
  connector: Connector;
  cut(): void;
  cutAfter(method: string): void;
} {
  const base = socketConnector();
  const live = new Set<Connection>();
  let after: string | null = null;
  const cut = (): void => {
    for (const c of [...live]) c.close();
    live.clear();
  };
  return {
    connector: async (path, handlers) => {
      const c = await base(path, handlers);
      live.add(c);
      void c.closed.then(() => live.delete(c));
      return {
        closed: c.closed,
        close: () => c.close(),
        send: (line) => {
          const sent = c.send(line);
          if (after && line.includes(`"method":"${after}"`)) {
            after = null;
            // Sale entera y después se corta: llega al daemon, la respuesta no vuelve.
            setTimeout(cut, 30);
          }
          return sent;
        },
      };
    },
    cut,
    cutAfter: (method) => {
      after = method;
    },
  };
}

export const runEnded = (e: ProtocolEvent): boolean =>
  e.type === 'run.completed' || e.type === 'run.failed' || e.type === 'run.cancelled';

/** El evento que deja la sesión parada otra vez tras un run. */
export const idleAgain = (e: ProtocolEvent): boolean =>
  e.type === 'session.updated' && e.data.session.state === 'idle' && e.seq > 1;
