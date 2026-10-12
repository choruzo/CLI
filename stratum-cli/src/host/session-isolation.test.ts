import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SessionHost } from './session-host.js';
import { ProviderRouter } from '../providers/router.js';
import { MockProvider, makeTextRound, makeToolCallRound } from '../providers/mock.js';
import { StratumConfigSchema } from '../config/schema.js';
import { createSessionEnv } from '../runtime/session-env.js';
import { getSshPool } from '../tools/ssh/runtime.js';
import { closeExecRuntime } from '../tools/exec/runtime.js';
import type { OpenAIStreamChunk } from '../providers/base.js';
import type { AgentEvent } from '../agent/types.js';

/**
 * AC-0 del PRD de Stratum Dot (obligatorio para M0):
 *
 *   Dos `SessionHost` con cwd diferentes deben poder coexistir en el mismo
 *   proceso y destruir uno no debe alterar jobs, SSH, auditoría ni cwd del otro.
 *
 * Todo va por el camino real: la tool `exec` de verdad, el shell local, el
 * `JobManager` y la auditoría en disco. Lo único de guion es el modelo.
 */

const base = realpathSync(mkdtempSync(join(tmpdir(), 'stratum-ac0-')));
const processCwd = process.cwd();

afterAll(async () => {
  await closeExecRuntime();
  rmSync(base, { recursive: true, force: true });
});

const hosts: SessionHost[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((h) => h.dispose({ cancelBackground: true })));
});

const node = (script: string): string => `node -e "${script}"`;
const PRINT_CWD = node('console.log(process.cwd())');
const PRINT_VAR = node('console.log(process.env.STRATUM_AC0)');
const STAY_ALIVE = node('setInterval(() => {}, 1000)');

/** Una sesión con su directorio, su variable, su fichero de auditoría y su guion. */
async function session(
  name: string,
  rounds: OpenAIStreamChunk[][],
): Promise<{ host: SessionHost; cwd: string; auditFile: string }> {
  const cwd = join(base, name);
  mkdirSync(cwd, { recursive: true });
  const auditFile = join(base, `${name}-audit.jsonl`);
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
    skills: { enabled: false },
    tools: { auditLog: auditFile },
    trace: { enabled: false },
  });
  const router = new ProviderRouter(config);
  vi.spyOn(router, 'getActive').mockReturnValue(new MockProvider(rounds));
  const host = await SessionHost.create({
    env: createSessionEnv({ cwd, env: { ...process.env, STRATUM_AC0: `var-de-${name}` } }),
    config,
    router,
    mcp: 'none',
    destructivePolicy: 'allow',
    allowDestructive: true,
  });
  hosts.push(host);
  return { host, cwd, auditFile };
}

async function collect(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const ev of gen) events.push(ev);
  return events;
}

/** Salidas de las tools de un turno, en orden; falla si alguna dio error. */
function outputs(events: AgentEvent[]): string[] {
  const errors = events.flatMap((e) => (e.type === 'tool_error' ? [`${e.name}: ${e.error}`] : []));
  expect(errors).toEqual([]);
  return events.flatMap((e) => (e.type === 'tool_result' ? [e.result] : []));
}

const samePath = (text: string, path: string): boolean =>
  text.replace(/\\/g, '/').toLowerCase().includes(path.replace(/\\/g, '/').toLowerCase());

function auditRecords(file: string): Array<Record<string, unknown>> {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** Guion de una sesión: mira dónde está, lee su variable, escribe un fichero y lanza un job. */
function script(name: string): OpenAIStreamChunk[][] {
  return [
    makeToolCallRound('c1', 'exec', { command: PRINT_CWD }),
    makeToolCallRound('c2', 'exec', { command: PRINT_VAR }),
    makeToolCallRound('c3', 'write_file', { path: 'nota.txt', content: `soy ${name}` }),
    makeToolCallRound('c4', 'exec', { command: STAY_ALIVE, background: true }),
    makeTextRound('listo'),
    // Segundo turno, tras cerrar la otra sesión.
    makeToolCallRound('c5', 'exec', { command: PRINT_CWD }),
    makeTextRound('sigo aquí'),
  ];
}

describe('AC-0 — dos SessionHost en el mismo proceso', () => {
  it('coexisten con cwd distintos, y destruir uno no altera jobs, SSH, auditoría ni cwd del otro', async () => {
    const a = await session('a', script('a'));
    const b = await session('b', script('b'));
    expect(a.cwd).not.toBe(b.cwd);
    expect(a.cwd).not.toBe(processCwd);

    // --- Coexistencia: los dos turnos a la vez. ---
    const [eventsA, eventsB] = await Promise.all([
      collect(a.host.run('trabaja')),
      collect(b.host.run('trabaja')),
    ]);
    const outA = outputs(eventsA);
    const outB = outputs(eventsB);

    // cwd: cada `exec` corre en el directorio de su sesión.
    expect(samePath(outA[0]!, a.cwd)).toBe(true);
    expect(samePath(outB[0]!, b.cwd)).toBe(true);
    expect(samePath(outA[0]!, b.cwd)).toBe(false);
    // Variables: cada una ve las suyas.
    expect(outA[1]).toContain('var-de-a');
    expect(outB[1]).toContain('var-de-b');
    // Rutas relativas de las tools de fichero: cada una en su proyecto.
    expect(readFileSync(join(a.cwd, 'nota.txt'), 'utf-8')).toBe('soy a');
    expect(readFileSync(join(b.cwd, 'nota.txt'), 'utf-8')).toBe('soy b');
    // El directorio del proceso no se ha movido ni ha recibido nada.
    expect(process.cwd()).toBe(processCwd);
    expect(existsSync(join(processCwd, 'nota.txt'))).toBe(false);

    // Jobs: uno vivo por sesión, cada uno en su manager y en su cwd.
    const jobsA = a.host.agent.jobs!;
    const jobsB = b.host.agent.jobs!;
    expect(jobsA).not.toBe(jobsB);
    const [jobA] = jobsA.list();
    const [jobB] = jobsB.list();
    expect(jobA?.status).toBe('running');
    expect(jobB?.status).toBe('running');
    expect(samePath(jobA!.cwd, a.cwd)).toBe(true);
    expect(samePath(jobB!.cwd, b.cwd)).toBe(true);

    // SSH y auditoría: estado propio por sesión.
    const poolB = getSshPool(b.host.config);
    expect(getSshPool(a.host.config)).not.toBe(poolB);
    let poolBClosed = 0;
    poolB.closeAll = async () => void poolBClosed++;

    // --- Destruir A. ---
    await a.host.dispose({ cancelBackground: true });

    // Jobs: los de A se cancelan; el de B sigue corriendo y B puede lanzar más.
    expect(jobsA.get(jobA!.id)?.status).toBe('cancelled');
    expect(jobsA.isClosed).toBe(true);
    expect(jobsB.get(jobB!.id)?.status).toBe('running');
    expect(jobsB.isClosed).toBe(false);

    // SSH: el pool de B es el mismo objeto y nadie lo ha cerrado.
    expect(poolBClosed).toBe(0);
    expect(getSshPool(b.host.config)).toBe(poolB);

    // Auditoría: la de A quedó vaciada a su fichero con sus comandos y el
    // cierre de su job; en la de B no hay nada de A.
    const auditA = auditRecords(a.auditFile);
    expect(auditA.length).toBeGreaterThanOrEqual(3);
    expect(auditA.every((r) => r.sessionId === a.host.sessionId)).toBe(true);

    // cwd: B sigue trabajando en su directorio, por el camino completo.
    const after = outputs(await collect(b.host.run('¿sigues ahí?')));
    expect(samePath(after[0]!, b.cwd)).toBe(true);
    expect(process.cwd()).toBe(processCwd);

    await b.host.dispose({ cancelBackground: true });
    const auditB = auditRecords(b.auditFile);
    expect(auditB.length).toBeGreaterThanOrEqual(4);
    expect(auditB.every((r) => r.sessionId === b.host.sessionId)).toBe(true);
    expect(jobsB.get(jobB!.id)?.status).toBe('cancelled');
    // Lanza y cancela procesos reales (en Windows cada cancelación barre el árbol, ~1 s).
  }, 60_000);
});
