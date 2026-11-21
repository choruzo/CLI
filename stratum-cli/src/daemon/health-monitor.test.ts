import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProtocolHealthNotice } from '../protocol/index.js';
import type { ProbeOutcome, WatchProbe } from '../watches/probe.js';
import { HealthStore, healthFile } from '../health/store.js';
import { HealthMonitor, type HealthBox, type HealthConnector } from './health-monitor.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stratum-health-monitor-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const GOOGLE: HealthConnector = { id: 'google', name: 'Google', tool: 'google_acceso' };

function ran(estado: string, detalle = 'detalle'): ProbeOutcome {
  return { kind: 'ran', outcomes: [{ ok: true, result: { estado, valor: null, detalle } }] };
}

interface Rig {
  monitor: HealthMonitor;
  notices: ProtocolHealthNotice[];
  outcomes: (ProbeOutcome | Error)[];
  probe: WatchProbe & { run: ReturnType<typeof vi.fn> };
  connectors: HealthConnector[];
  box: { agent: { state: 'running' | 'unavailable'; outdated: boolean }; connectors: boolean };
  failDelivery: { value: boolean };
}

function rig(opts: { box?: boolean; connectors?: HealthConnector[] } = {}): Rig {
  const notices: ProtocolHealthNotice[] = [];
  const outcomes: (ProbeOutcome | Error)[] = [];
  const failDelivery = { value: false };
  const connectors = opts.connectors ?? [GOOGLE];
  const boxState: Rig['box'] = {
    agent: { state: 'running', outdated: false },
    connectors: false,
  };
  const box: HealthBox = {
    status: async () => ({ ...boxState.agent }),
    connectorsStatus: async () => ({ state: 'running', outdated: boxState.connectors }),
  };
  const probe = {
    run: vi.fn(async () => {
      const next = outcomes.shift() ?? ran('ok');
      if (next instanceof Error) throw next;
      return next;
    }),
  };
  const monitor = new HealthMonitor({
    store: new HealthStore(healthFile(dir)),
    probe,
    connectors: () => connectors,
    box: opts.box === false ? null : box,
    notify: async (n) => {
      if (failDelivery.value) throw new Error('no session');
      notices.push(n);
    },
    now: () => 1_000,
    firstDelayMs: 1e9,
  });
  monitor.start();
  return { monitor, notices, outcomes, probe, connectors, box: boxState, failDelivery };
}

describe('HealthMonitor', () => {
  it('una credencial rechazada se avisa una vez, y luego que vuelve a ir', async () => {
    const r = rig();
    r.outcomes.push(ran('auth', 'Google rechazó'), ran('auth'), ran('ok'), ran('ok'));
    for (let i = 0; i < 4; i++) await r.monitor.runOnce();
    expect(r.notices.map((n) => [n.cause, n.kind])).toEqual([
      ['connector:google:auth', 'degraded'],
      ['connector:google:auth', 'recovered'],
    ]);
    expect(r.notices[0]!.text).toContain('stratum connectors setup google');
    expect(r.notices[0]!.area).toBe('connectors');
    expect(r.notices[0]!.connector).toBe('google');
    expect(r.probe.run).toHaveBeenCalledWith('google', [{ tool: 'google_acceso', args: {} }]);
  });

  it('lo avisado no se repite tras reiniciar', async () => {
    const r = rig();
    r.outcomes.push(ran('auth'));
    await r.monitor.runOnce();
    expect(r.notices).toHaveLength(1);
    const r2 = rig();
    r2.outcomes.push(ran('auth'));
    await r2.monitor.runOnce();
    expect(r2.notices).toHaveLength(0);
  });

  it('un fallo que no es auth avisa al segundo, con el motivo neutralizado', async () => {
    const r = rig();
    r.outcomes.push(ran('unreachable', 'No se llega‮ a Google'), ran('unreachable', 'otra vez'));
    await r.monitor.runOnce();
    expect(r.notices).toHaveLength(0);
    await r.monitor.runOnce();
    expect(r.notices).toHaveLength(1);
    expect(r.notices[0]!.cause).toBe('connector:google:failing');
    expect(r.notices[0]!.text).toContain('otra vez');
  });

  it('una sonda que lanza o una comprobación que falla cuentan como fallo, nunca auth', async () => {
    const r = rig();
    r.outcomes.push(new Error('spawn failed'), {
      kind: 'ran',
      outcomes: [{ ok: false, reason: 'isError' }],
    });
    await r.monitor.runOnce();
    await r.monitor.runOnce();
    expect(r.notices.map((n) => n.cause)).toEqual(['connector:google:failing']);
    expect(r.monitor.accessResults().get('google')?.status).toBe('error');
  });

  it('suspendido no cambia nada', async () => {
    const r = rig();
    r.outcomes.push(
      ran('error'),
      { kind: 'suspended', reason: 'no box' },
      { kind: 'suspended', reason: 'no box' },
    );
    for (let i = 0; i < 3; i++) await r.monitor.runOnce();
    expect(r.notices).toHaveLength(0);
  });

  it('un aviso que no se entrega se reintenta en la pasada siguiente', async () => {
    const r = rig();
    r.failDelivery.value = true;
    r.outcomes.push(ran('auth'));
    await r.monitor.runOnce();
    expect(r.notices).toHaveLength(0);
    r.failDelivery.value = false;
    r.outcomes.push(ran('auth'));
    await r.monitor.runOnce();
    expect(r.notices.map((n) => n.cause)).toEqual(['connector:google:auth']);
  });

  it('un conector desactivado se olvida sin avisar', async () => {
    const r = rig();
    r.outcomes.push(ran('auth'));
    await r.monitor.runOnce();
    r.connectors.splice(0);
    await r.monitor.runOnce();
    r.connectors.push(GOOGLE);
    r.outcomes.push(ran('auth'));
    await r.monitor.runOnce();
    // Al volver a activarlo, es una causa nueva.
    expect(r.notices.map((n) => n.kind)).toEqual(['degraded', 'degraded']);
  });

  it('la caja desfasada se avisa una vez y se olvida en silencio', async () => {
    const r = rig({ connectors: [] });
    r.box.agent.outdated = true;
    await r.monitor.runOnce();
    await r.monitor.runOnce();
    expect(r.notices.map((n) => [n.cause, n.area, n.connector])).toEqual([
      ['box:image', 'box', null],
    ]);
    r.box.agent.outdated = false;
    await r.monitor.runOnce();
    expect(r.notices).toHaveLength(1);
    r.box.connectors = true;
    await r.monitor.runOnce();
    expect(r.notices).toHaveLength(2);
  });

  it('sin runtime no se sabe nada de la caja', async () => {
    const r = rig({ connectors: [] });
    r.box.agent = { state: 'unavailable', outdated: false };
    await r.monitor.runOnce();
    expect(r.notices).toHaveLength(0);
  });

  it('sin caja habilitada no se mira su imagen', async () => {
    const r = rig({ box: false, connectors: [] });
    await r.monitor.runOnce();
    expect(r.notices).toHaveLength(0);
  });
});
