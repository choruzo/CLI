/**
 * Arnés de los tests de integración del daemon: un `Stratumd` de verdad sobre un
 * pipe real, clientes de verdad (`StratumClient`) y sesiones de verdad
 * (`SessionHost`, tools, jobs). Lo único de guion es el modelo.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { StratumClient } from '../client/client.js';
import { fileDiscovery } from '../client/discovery.js';
import { StratumConfigSchema, type StratumConfig } from '../config/schema.js';
import type { SessionStartupOptions } from '../host/session-startup.js';
import type { CompletionRequest, IProvider, OpenAIStreamChunk } from '../providers/base.js';
import { makeTextRound } from '../providers/mock.js';
import { ProviderRouter } from '../providers/router.js';
import type {
  ProtocolEvent,
  ProtocolSessionSnapshot,
  ProtocolStateEvent,
  Role,
} from '../protocol/index.js';
import { Stratumd, type StratumdOptions } from './daemon.js';

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

/** Modelo de guion: una ronda por petición, en orden. Atiende la cancelación. */
export class ScriptedProvider implements IProvider {
  calls = 0;

  constructor(private readonly rounds: Round[]) {}

  async *complete(req: CompletionRequest): AsyncGenerator<OpenAIStreamChunk> {
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
  connect(roles: Role[], name?: string): Promise<StratumClient>;
  stop(): Promise<void>;
}

export async function startTestDaemon(
  options: Partial<StratumdOptions> & { base?: string } = {},
): Promise<TestDaemon> {
  const ownBase = options.base === undefined;
  const base = options.base ?? realpathSync(mkdtempSync(join(tmpdir(), 'stratumd-')));
  const dir = options.dir ?? join(base, 'daemon');
  const scripts = new Map<string, { rounds: Round[]; config: Record<string, unknown> }>();
  const providers = new Map<string, ScriptedProvider>();
  const clients: StratumClient[] = [];
  let teardowns = 0;
  let sessions = 0;

  const configFor = (extra: Record<string, unknown> = {}): StratumConfig =>
    StratumConfigSchema.parse({
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
      tools: { auditLog: join(base, `audit-${++sessions}.jsonl`) },
      trace: { enabled: false },
      ...extra,
    });

  const { base: _base, ...daemonOptions } = options;
  void _base;
  const daemon = await Stratumd.start({
    version: '0.0.0-test',
    config: configFor(),
    env: { ...process.env, STRATUMD_TEST: 'daemon-env' },
    dir,
    processTeardown: async () => {
      teardowns++;
    },
    startup: async (opts: SessionStartupOptions) => {
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
    async connect(roles, name = 'test-client') {
      const client = new StratumClient({
        discovery: fileDiscovery({ dir }),
        identity: { kind: 'cli', name, version: '0.0.0-test', roles },
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

export const runEnded = (e: ProtocolEvent): boolean =>
  e.type === 'run.completed' || e.type === 'run.failed' || e.type === 'run.cancelled';

/** El evento que deja la sesión parada otra vez tras un run. */
export const idleAgain = (e: ProtocolEvent): boolean =>
  e.type === 'session.updated' && e.data.session.state === 'idle' && e.seq > 1;
