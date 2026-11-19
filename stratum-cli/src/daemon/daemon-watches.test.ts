/**
 * M22 — los vigilantes del `companion` sobre un daemon real: el aviso sale como
 * `watch.notice` en la sesión del `companion` (fuera de cualquier run y también
 * en la suscripción `overview`), un vigilante activo mantiene vivo el daemon, y
 * con `watches: null` no hay planificador.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { makeTextRound } from '../providers/mock.js';
import type { ProtocolEvent } from '../protocol/index.js';
import { INITIAL_WATCH_STATE } from '../watches/engine.js';
import type { ProbeCall, ProbeOutcome, WatchProbe } from '../watches/probe.js';
import { WATCHES_SCHEMA_VERSION, WatchStore, watchesFile } from '../watches/store.js';
import { startTestDaemon, type Round, type TestDaemon } from './daemon.fixtures.js';

const daemons: TestDaemon[] = [];
const bases: string[] = [];
afterEach(async () => {
  for (const d of daemons.splice(0)) await d.stop().catch(() => undefined);
  for (const b of bases.splice(0)) rmSync(b, { recursive: true, force: true });
});

function newBase(): string {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'stratumd-m22-')));
  bases.push(base);
  return base;
}

async function daemonAt(
  base: string,
  options: Parameters<typeof startTestDaemon>[0] = {},
): Promise<TestDaemon> {
  const t = await startTestDaemon({ base, ...options });
  daemons.push(t);
  return t;
}

const companionProject = (t: TestDaemon, rounds: Round[]): string =>
  t.project(join('companion', 'workspace'), rounds);

async function until(check: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('timeout waiting for condition');
    await new Promise((r) => setTimeout(r, 15));
  }
}

/** Un vigilante ya escrito en disco (lo que deja un daemon anterior). */
function storedWatch(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'wat_1',
    name: 'Salón',
    connector: 'casa',
    check: 'estado',
    args: { entity_id: 'light.salon' },
    condition: { kind: 'state-is', values: ['on'] },
    intervalSec: 60,
    cooldownMinutes: 30,
    notifyResolved: false,
    status: 'active',
    origin: 'person',
    createdAt: 1,
    state: INITIAL_WATCH_STATE,
    ...over,
  };
}

/** Un `watches.json` en la carpeta del test con esos vigilantes. */
function watchesStore(base: string, watches: Array<Record<string, unknown>>): WatchStore {
  const file = watchesFile(join(base, 'companion'));
  mkdirSync(join(base, 'companion'), { recursive: true });
  writeFileSync(file, JSON.stringify({ schemaVersion: WATCHES_SCHEMA_VERSION, watches }), 'utf-8');
  return new WatchStore(file);
}

/** Una sonda que devuelve `off` la primera vez y `on` a partir de entonces. */
function probeOffThenOn(): WatchProbe & { calls: number } {
  let count = 0;
  const probe = {
    get calls() {
      return count;
    },
    async run(_connector: string, calls: readonly ProbeCall[]): Promise<ProbeOutcome> {
      const estado = count++ === 0 ? 'off' : 'on';
      return {
        kind: 'ran',
        outcomes: calls.map(() => ({
          ok: true as const,
          result: { estado, valor: null, detalle: `Salón — ${estado}` },
        })),
      };
    },
  };
  return probe as unknown as WatchProbe & { calls: number };
}

/**
 * Se suscribe a `overview` y espera la primera foto: el servidor ya tiene la
 * suscripción, así que un evento publicado después no se pierde.
 */
async function watchOverview(client: {
  subscribeOverview(h: {
    onOverview: (o: unknown) => void;
    onEvent: (e: ProtocolEvent) => void;
  }): unknown;
}): Promise<ProtocolEvent[]> {
  const events: ProtocolEvent[] = [];
  await new Promise<void>((resolve) => {
    let first = true;
    client.subscribeOverview({
      onOverview: () => {
        if (!first) return;
        first = false;
        resolve();
      },
      onEvent: (e) => events.push(e),
    });
  });
  return events;
}

const noticeEvents = (events: ProtocolEvent[]): ProtocolEvent[] =>
  events.filter((e) => e.type === 'watch.notice');

describe('M22 — vigilantes del daemon', () => {
  it('un vigilante que salta llega como watch.notice en la sesión del companion, fuera de un run', async () => {
    const base = newBase();
    const watches = watchesStore(base, [storedWatch()]);
    // El reloj del daemon se mueve a mano: el intervalo mínimo es de 60 s.
    let now = Date.now();
    const probe = probeOffThenOn();
    const t = await daemonAt(base, {
      watches,
      watchProbe: probe,
      watchTickMs: 50,
      now: () => now,
    });
    companionProject(t, [makeTextRound('aquí estoy')]);
    const dot = await t.connect(['operator'], 'stratum-dot', { kind: 'dot' });
    const observer = await t.connect(['observer'], 'obs');
    const { session } = await dot.request('sessions.open', { agent: 'companion' });
    const events = await watchOverview(observer);

    // Primera vuelta: la condición no se cumple, así que no hay aviso.
    await until(() => probe.calls >= 1);
    await new Promise((r) => setTimeout(r, 120));
    expect(noticeEvents(events)).toEqual([]);

    // Pasa el intervalo: la siguiente vuelta la ve cumplirse y salta.
    now += 61_000;
    await until(() => noticeEvents(events).length > 0);
    const notice = noticeEvents(events)[0] as unknown as {
      sessionId: string;
      runId?: string;
      data: { notice: Record<string, unknown> };
    };
    expect(notice.sessionId).toBe(session.id);
    // Fuera de un run: el aviso no abre turno ni lleva run detrás.
    expect(notice.runId).toBeUndefined();
    expect(events.some((e) => e.type === 'run.started')).toBe(false);
    expect(notice.data.notice).toMatchObject({ watchId: 'wat_1', name: 'Salón', kind: 'fired' });
    expect(String(notice.data.notice.text)).toContain('Vigilante «Salón»: el estado es «on»');
    // El aviso no lanza un turno ni entra en la conversación.
    const { snapshot } = await dot.request('sessions.get', { sessionId: session.id });
    expect(snapshot.session.state).toBe('idle');
    expect(snapshot.messages).toEqual([]);
  }, 30_000);

  it('un vigilante activo mantiene el daemon vivo; sin él, se apaga solo', async () => {
    const base = newBase();
    const watches = watchesStore(base, [storedWatch()]);
    const probe = probeOffThenOn();
    const t = await daemonAt(base, {
      watches,
      watchProbe: probe,
      watchTickMs: 50,
      idleExitMs: 150,
    });
    let closed = false;
    void t.daemon.closed.then(() => (closed = true));
    // Más del doble del plazo de inactividad: el vigilante lo mantiene vivo.
    await new Promise((r) => setTimeout(r, 700));
    expect(closed).toBe(false);
    expect(t.daemon.watches!.hasActive).toBe(true);

    // Sin ninguno activo, ya no hay nada que esperar.
    t.daemon.watches!.remove('wat_1');
    expect(t.daemon.watches!.hasActive).toBe(false);
    expect(await t.daemon.closed).toBe('idle');
  }, 20_000);

  it('con `watches: null` no hay planificador', async () => {
    const t = await daemonAt(newBase(), { watches: null });
    expect(t.daemon.watches).toBeNull();
    const observer = await t.connect(['observer'], 'obs');
    // Y el daemon funciona igual: no hay ningún aviso que esperar.
    expect((await observer.request('sessions.list', {})).sessions).toEqual([]);
  }, 20_000);

  it('con el vigilante en solo lectura no se evalúa, pero el daemon sigue en pie', async () => {
    const base = newBase();
    const file = watchesFile(join(base, 'companion'));
    mkdirSync(join(base, 'companion'), { recursive: true });
    // De un Stratum más nuevo: se lee, no se toca y no se evalúa nada.
    writeFileSync(file, JSON.stringify({ schemaVersion: 99, watches: [] }), 'utf-8');
    const probe = probeOffThenOn();
    const t = await daemonAt(base, {
      watches: new WatchStore(file),
      watchProbe: probe,
      watchTickMs: 50,
    });
    expect(t.daemon.watches!.readOnly).toBe(true);
    await new Promise((r) => setTimeout(r, 200));
    expect(probe.calls).toBe(0);
    // En solo lectura no cuenta como «activo»: no impide el apagado por inactividad.
    expect(t.daemon.watches!.hasActive).toBe(false);
  }, 20_000);
});
