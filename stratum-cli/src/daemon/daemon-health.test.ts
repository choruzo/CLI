/**
 * M23 — avisos de degradación sobre un daemon real: una credencial rechazada en
 * la comprobación de acceso de un conector llega como `health.notice` en la
 * sesión del `companion` (fuera de cualquier run y en `overview`), se avisa una
 * sola vez, `doctor.run` la enseña, y con `health: null` no hay monitor.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { makeTextRound } from '../providers/mock.js';
import type { ProtocolEvent } from '../protocol/index.js';
import { healthNoticeSchema } from '../protocol/schemas.js';
import { loadConnectorCatalog } from '../connectors/catalog.js';
import { connectorsFile, enableConnector } from '../connectors/store.js';
import type { ProbeCall, ProbeOutcome, WatchProbe } from '../watches/probe.js';
import { startTestDaemon, type TestDaemon } from './daemon.fixtures.js';

const daemons: TestDaemon[] = [];
const bases: string[] = [];
afterEach(async () => {
  for (const d of daemons.splice(0)) await d.stop().catch(() => undefined);
  for (const b of bases.splice(0)) rmSync(b, { recursive: true, force: true });
});

function newBase(): string {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'stratumd-m23-health-')));
  bases.push(base);
  return base;
}

// Con la suite entera en paralelo, la primera pasada del monitor tarda más de 10 s
// (y en la release de la 0.17.0, más de 30 s dos veces seguidas).
async function until(check: () => boolean, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timeout waiting for condition');
    await new Promise((r) => setTimeout(r, 15));
  }
}

/** Un conector de pruebas con comprobación de acceso (`access`). */
function writeCatalog(base: string): string {
  const dir = join(base, 'catalog');
  mkdirSync(join(dir, 'cuenta'), { recursive: true });
  writeFileSync(
    join(dir, 'cuenta', 'connector.json'),
    JSON.stringify({
      schemaVersion: 1,
      id: 'cuenta',
      version: '1.0.0',
      name: 'Mi cuenta',
      description: 'Un conector de pruebas.',
      agents: ['companion'],
      hosts: ['api.example.com'],
      secrets: [],
      tools: [{ name: 'cuenta_acceso', readOnly: true, summary: 'Comprueba el acceso' }],
      checks: [{ tool: 'cuenta_acceso', summary: 'Acceso', minIntervalSec: 300, args: [] }],
      access: 'cuenta_acceso',
    }),
  );
  return dir;
}

function authProbe(): WatchProbe & { calls: ProbeCall[][] } {
  const calls: ProbeCall[][] = [];
  return {
    calls,
    async run(_connector, c): Promise<ProbeOutcome> {
      calls.push([...c]);
      return {
        kind: 'ran',
        outcomes: [
          { ok: true, result: { estado: 'auth', valor: null, detalle: 'Token rechazado' } },
        ],
      };
    },
  };
}

describe('M23 — avisos de degradación del daemon', () => {
  it('una credencial rechazada llega una vez como health.notice y doctor la enseña', async () => {
    const base = newBase();
    const companion = join(base, 'companion');
    mkdirSync(companion, { recursive: true });
    enableConnector(connectorsFile(companion), 'cuenta', new Date());
    const probe = authProbe();
    const t = await startTestDaemon({
      base,
      connectorCatalog: loadConnectorCatalog(writeCatalog(base)),
      watchProbe: probe,
      watches: null,
      healthTiming: { firstDelayMs: 50, tickMs: 50 },
      loginAutostart: async () => null,
    });
    daemons.push(t);
    t.project(join('companion', 'workspace'), [makeTextRound('aquí estoy')]);
    const observer = await t.connect(['observer'], 'obs');
    const events: ProtocolEvent[] = [];
    await new Promise<void>((resolve) => {
      let first = true;
      observer.subscribeOverview({
        onOverview: () => {
          if (first) resolve();
          first = false;
        },
        onEvent: (e) => events.push(e),
      });
    });
    const notices = () => events.filter((e) => e.type === 'health.notice');

    await until(() => notices().length > 0);
    // Varias pasadas más: no se repite.
    await until(() => probe.calls.length >= 4);
    expect(notices()).toHaveLength(1);
    expect(probe.calls[0]).toEqual([{ tool: 'cuenta_acceso', args: {} }]);
    const event = notices()[0] as unknown as { runId?: string; data: { notice: unknown } };
    expect(event.runId).toBeUndefined();
    const notice = healthNoticeSchema.parse(event.data.notice);
    expect(notice).toMatchObject({
      cause: 'connector:cuenta:auth',
      kind: 'degraded',
      area: 'connectors',
      connector: 'cuenta',
    });
    expect(notice.text).toContain('Mi cuenta');
    expect(notice.text).toContain('stratum connectors setup cuenta');

    const { report } = await observer.request('doctor.run', {});
    const check = report.checks.find((c) => c.id === 'connector.cuenta');
    expect(check).toMatchObject({
      status: 'fail',
      detail: 'Token rechazado',
      fix: 'stratum connectors setup cuenta',
    });
  }, 150_000);

  it('con `health: null` no hay monitor', async () => {
    const base = newBase();
    const companion = join(base, 'companion');
    mkdirSync(companion, { recursive: true });
    enableConnector(connectorsFile(companion), 'cuenta', new Date());
    const probe = authProbe();
    const t = await startTestDaemon({
      base,
      connectorCatalog: loadConnectorCatalog(writeCatalog(base)),
      watchProbe: probe,
      watches: null,
      health: null,
      healthTiming: { firstDelayMs: 20, tickMs: 20 },
    });
    daemons.push(t);
    await new Promise((r) => setTimeout(r, 200));
    expect(probe.calls).toHaveLength(0);
  });
});
