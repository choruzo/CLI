/**
 * Integración UX-1 en `StratumAgent`: el turno deja un snapshot deshacible, se
 * revierte con la API del agente y el turno siguiente abre con el aviso
 * `<files_reverted>`. Todo con git real en un directorio temporal y el home del
 * almacén inyectado (nunca se escribe en el `~` del usuario).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execa } from 'execa';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { StratumAgent } from '../agent/core.js';
import { ProviderRouter } from '../providers/router.js';
import { ToolRegistry } from '../tools/registry.js';
import { registerBuiltinTools } from '../tools/index.js';
import { MockProvider, makeTextRound, makeToolCallRound } from '../providers/mock.js';
import { StratumConfigSchema } from '../config/schema.js';
import { createSessionEnv } from '../runtime/session-env.js';
import type { AgentEvent } from '../agent/types.js';

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
  memory: { autoExtract: false },
  trace: { enabled: false },
  tools: { auditLog: false },
});

async function collect(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const ev of gen) events.push(ev);
  return events;
}

let repo: string;
let home: string;

async function initRepo(dir: string): Promise<void> {
  await execa('git', ['init', '-q'], { cwd: dir, reject: false });
  await execa('git', ['config', 'user.email', 'test@example.com'], { cwd: dir, reject: false });
  await execa('git', ['config', 'user.name', 'test'], { cwd: dir, reject: false });
}

/** Agente con un guion de provider y el cwd en el repo temporal. */
function makeAgent(rounds: ReturnType<typeof makeTextRound>[]): StratumAgent {
  const provider = new MockProvider(rounds);
  const router = new ProviderRouter(config);
  vi.spyOn(router, 'getActive').mockReturnValue(provider);
  const registry = new ToolRegistry();
  registerBuiltinTools(registry, config);
  return new StratumAgent(config, router, registry, {
    env: createSessionEnv({ cwd: repo, env: {} }),
    sessionId: 'ses_agent_test',
    snapshotsHome: home,
    initialMessages: [{ role: 'system', content: 'sys' }],
  });
}

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'stratum-snap-agent-'));
  home = await mkdtemp(join(tmpdir(), 'stratum-snap-agent-home-'));
  await initRepo(repo);
});

afterEach(async () => {
  for (const dir of [repo, home]) {
    try {
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    } catch {
      // Un lock de Windows no invalida el test.
    }
  }
  vi.restoreAllMocks();
});

describe('StratumAgent + snapshots (UX-1)', () => {
  it(
    'un turno que escribe deja un turno deshacible, revertTurns(1) lo deshace y el siguiente run lleva <files_reverted>',
    { timeout: 90_000 },
    async () => {
      await writeFile(join(repo, 'base.txt'), 'base\n');
      const agent = makeAgent([
        makeToolCallRound('c1', 'write_file', { path: 'creado.txt', content: 'hola\n' }),
        makeTextRound('hecho'),
        makeTextRound('sigo'),
      ]);

      await collect(agent.run('crea creado.txt'));
      expect(existsSync(join(repo, 'creado.txt'))).toBe(true);

      const turns = agent.getUndoableTurns();
      expect(turns).toHaveLength(1);
      expect(turns[0]!.files.map((f) => f.path)).toContain('creado.txt');
      expect(turns[0]!.files.find((f) => f.path === 'creado.txt')!.status).toBe('added');
      // «Cambios por turno»: el registro del turno recién cerrado.
      expect(agent.getLastTurnChanges()?.turn).toBe(turns[0]!.turn);

      const plan = await agent.planRevert(1);
      expect(plan.turns).toEqual([turns[0]!.turn]);
      expect(plan.remove).toContain('creado.txt');
      expect(plan.conflicts).toEqual([]);

      const result = await agent.revertTurns(1);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.removed).toContain('creado.txt');
      expect(existsSync(join(repo, 'creado.txt'))).toBe(false);
      expect(agent.getUndoableTurns()).toEqual([]);

      // El turno siguiente abre con el aviso, delante de la petición nueva.
      await collect(agent.run('continua'));
      const notice = agent
        .getMessages()
        .find((m) => m.role === 'user' && (m.content ?? '').includes('<files_reverted'));
      expect(notice).toBeDefined();
      expect(notice!.content).toContain(`turns="${turns[0]!.turn}"`);
      expect(notice!.content).toContain('Removed: creado.txt');
      // Un turno que no toca ficheros no arrastra el registro del anterior.
      expect(agent.getLastTurnChanges()).toBeNull();
    },
  );

  it('rechaza deshacer con un turno en curso', { timeout: 90_000 }, async () => {
    const agent = makeAgent([
      makeToolCallRound('c1', 'write_file', { path: 'a.txt', content: 'a\n' }),
      makeTextRound('hecho'),
    ]);

    let during: Awaited<ReturnType<StratumAgent['revertTurns']>> | null = null;
    for await (const event of agent.run('trabaja')) {
      if (event.type === 'tool_result' && during === null) {
        during = await agent.revertTurns(1);
        expect(await agent.planRevert(1)).toMatchObject({ turns: [] });
      }
    }
    expect(during).toEqual({ ok: false, reason: 'turn-in-progress' });
    // El turno terminó igualmente y quedó registrado como deshacible.
    expect(agent.getUndoableTurns()).toHaveLength(1);
  });

  it(
    'sin `sessionId` los snapshots quedan desactivados sin romper el turno',
    { timeout: 90_000 },
    async () => {
      const provider = new MockProvider([makeTextRound('hola')]);
      const router = new ProviderRouter(config);
      vi.spyOn(router, 'getActive').mockReturnValue(provider);
      const registry = new ToolRegistry();
      registerBuiltinTools(registry, config);
      const agent = new StratumAgent(config, router, registry, {
        env: createSessionEnv({ cwd: repo, env: {} }),
        snapshotsHome: home,
        initialMessages: [{ role: 'system', content: 'sys' }],
      });

      const events = await collect(agent.run('saluda'));
      expect(events.some((e) => e.type === 'done')).toBe(true);
      expect(agent.getUndoableTurns()).toEqual([]);
      expect(agent.getLastTurnChanges()).toBeNull();
      expect(await agent.revertTurns(1)).toEqual({ ok: false, reason: 'disabled' });
      expect(await agent.planRevert(1)).toMatchObject({ turns: [] });
    },
  );
});
