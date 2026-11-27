import { describe, expect, it } from 'vitest';
import { DOCTOR_LIMITS } from '../protocol/index.js';
import { doctorCheckSchema } from '../protocol/schemas.js';
import { doctorChecks, worstStatus, type DoctorFacts } from './checks.js';

function facts(extra: Partial<DoctorFacts> = {}): DoctorFacts {
  return {
    daemon: { running: { version: '1.0.0', pid: 42 }, clientVersion: null, loginAutostart: null },
    box: null,
    connectors: null,
    telegram: null,
    model: null,
    stores: null,
    watches: null,
    ...extra,
  };
}

const byId = (f: DoctorFacts) => new Map(doctorChecks(f).map((c) => [c.id, c]));

const runningBox = {
  enabled: true,
  autostart: true,
  desktop: true,
  status: { state: 'running' as const, runtime: 'docker' as const, reason: null, outdated: false },
  autostartRun: { phase: 'started', reason: null },
};

describe('doctorChecks (M23)', () => {
  it('daemon: parado es fallo; otra versión de la CLI, aviso', () => {
    expect(
      byId(facts({ daemon: { running: false, clientVersion: null, loginAutostart: null } })).get(
        'daemon.running',
      ),
    ).toMatchObject({
      status: 'fail',
      fix: 'stratum daemon start',
    });
    const v = byId(
      facts({
        daemon: {
          running: { version: '1.0.0', pid: 1 },
          clientVersion: '1.1.0',
          loginAutostart: null,
        },
      }),
    );
    expect(v.get('daemon.version')?.status).toBe('warn');
    // Sin saber si corre (la CLI sin poder preguntar), no se dice nada.
    expect(
      byId(facts({ daemon: { running: null, clientVersion: null, loginAutostart: null } })).has(
        'daemon.running',
      ),
    ).toBe(false);
  });

  it('caja: en marcha y con autoarranque, todo bien', () => {
    const c = doctorChecks(facts({ box: runningBox }));
    expect(c.map((x) => [x.id, x.status])).toEqual([
      ['daemon.running', 'ok'],
      ['box.runtime', 'ok'],
      ['box.state', 'ok'],
      ['box.autostart', 'ok'],
    ]);
  });

  it('caja: desfasada, parada, apagada y autoarranque fallido', () => {
    const m = byId(
      facts({
        box: {
          ...runningBox,
          enabled: false,
          status: { state: 'stopped', runtime: 'podman', reason: null, outdated: true },
          autostartRun: { phase: 'failed', reason: 'image build failed' },
        },
      }),
    );
    expect(m.get('box.state')?.status).toBe('off');
    expect(m.get('box.image')?.status).toBe('warn');
    expect(m.get('box.enabled')?.status).toBe('off');
    expect(m.get('box.autostart')).toMatchObject({ status: 'fail', detail: 'image build failed' });
  });

  it('caja sin runtime: fallo si está habilitada, con el motivo', () => {
    const m = byId(
      facts({
        box: {
          ...runningBox,
          status: {
            state: 'unavailable',
            runtime: null,
            reason: 'Docker is not running.',
            outdated: false,
          },
        },
      }),
    );
    expect(m.get('box.runtime')).toMatchObject({
      status: 'fail',
      detail: 'Docker is not running.',
    });
    expect(m.has('box.state')).toBe(false);
  });

  it('conectores: sin configurar, desconocido, OAuth y fichero dañado', () => {
    const m = byId(
      facts({
        connectors: {
          file: 'ok',
          secretsFile: 'ok',
          box: { state: 'running', reason: null, outdated: false },
          enabled: [
            { id: 'a', name: 'A', unknown: false, missing: ['KEY'], oauth: false },
            { id: 'b', name: 'B', unknown: true, missing: [], oauth: false },
            { id: 'google', name: 'Google', unknown: false, missing: [], oauth: true },
          ],
        },
      }),
    );
    expect(m.get('connector.a')).toMatchObject({
      status: 'fail',
      fix: 'stratum connectors setup a',
    });
    expect(m.get('connector.b')?.status).toBe('warn');
    expect(m.get('connector.google')?.status).toBe('ok');
    expect(m.get('connector.google')?.detail).toContain('7 days');
    const damaged = byId(
      facts({ connectors: { file: 'invalid', secretsFile: 'absent', box: null, enabled: [] } }),
    );
    expect(damaged.get('connectors.file')?.status).toBe('fail');
    expect(damaged.has('connectors.enabled')).toBe(false);
  });

  it('Telegram: sin configurar, apagado, token rechazado, error de sondeo y sin emparejar', () => {
    const tg = (t: DoctorFacts['telegram']) => byId(facts({ telegram: t })).get('telegram');
    expect(tg({ configEnabled: false, file: 'absent', paired: 0, live: null })?.status).toBe('off');
    expect(tg({ configEnabled: false, file: 'ok', paired: 1, live: null })?.status).toBe('off');
    expect(
      tg({
        configEnabled: true,
        file: 'ok',
        paired: 1,
        live: { state: 'unauthorized', lastError: null },
      })?.status,
    ).toBe('fail');
    expect(
      tg({
        configEnabled: true,
        file: 'ok',
        paired: 1,
        live: { state: 'running', lastError: { kind: 'network', message: 'timeout' } },
      }),
    ).toMatchObject({ status: 'warn', detail: 'network: timeout' });
    const none = byId(
      facts({
        telegram: {
          configEnabled: true,
          file: 'ok',
          paired: 0,
          live: { state: 'running', lastError: null },
        },
      }),
    );
    expect(none.get('telegram')?.status).toBe('ok');
    expect(none.get('telegram.paired')?.status).toBe('warn');
  });

  it('modelo: provider caído y visión que falta solo si la caja tiene pantalla', () => {
    const model = {
      provider: 'nan',
      model: 'm1',
      source: 'session' as const,
      providerKnown: true,
      probe: 'unreachable' as const,
      vision: false,
    };
    const m = byId(facts({ box: runningBox, model }));
    expect(m.get('model.provider')?.status).toBe('fail');
    expect(m.get('model.vision')).toMatchObject({ status: 'warn' });
    expect(m.get('model.vision')?.fix).toContain('provider.providers.nan.models.m1.vision');
    expect(byId(facts({ model })).has('model.vision')).toBe(false);
    expect(
      byId(facts({ model: { ...model, providerKnown: false } })).get('model.provider')?.status,
    ).toBe('fail');
  });

  it('datos: un fichero en solo lectura y vigilantes suspendidos', () => {
    const m = byId(
      facts({
        stores: [
          { name: 'routines.json', readOnly: false },
          { name: 'watches.json', readOnly: true },
        ],
        watches: { active: 3, suspended: 2, failing: 1 },
      }),
    );
    expect(m.has('data.routines.json')).toBe(false);
    expect(m.get('data.watches.json')?.status).toBe('fail');
    expect(m.get('data.watches.suspended')?.title).toBe('2 of 3 active watches are suspended');
    expect(m.get('data.watches.failing')?.status).toBe('warn');
  });

  it('todo cabe en el contrato y se recorta a sus límites', () => {
    const long = 'x'.repeat(5000);
    const c = doctorChecks(
      facts({
        box: {
          ...runningBox,
          status: { state: 'unavailable', runtime: null, reason: long, outdated: false },
        },
        connectors: {
          file: 'ok',
          secretsFile: 'ok',
          box: null,
          enabled: Array.from({ length: 100 }, (_, i) => ({
            id: `c${i}`,
            name: long,
            unknown: false,
            missing: [],
            oauth: false,
          })),
        },
      }),
    );
    expect(c.length).toBe(DOCTOR_LIMITS.checks);
    for (const x of c) expect(doctorCheckSchema.parse(x)).toEqual(x);
  });

  it('worstStatus: off no es un problema', () => {
    const c = doctorChecks(
      facts({
        daemon: {
          running: null,
          clientVersion: null,
          loginAutostart: { enabled: false, detail: null },
        },
      }),
    );
    expect(c.map((x) => x.status)).toEqual(['off']);
    expect(worstStatus(c)).toBe('ok');
  });

  describe('voz (M25)', () => {
    const voice = (over: Partial<NonNullable<DoctorFacts['voice']>> = {}) =>
      facts({
        voice: {
          enabled: true,
          language: 'es',
          device: 'auto',
          model: 'ready',
          runtime: true,
          live: { lastNote: null, lastFailure: null },
          ...over,
        },
      });

    it('apagada: una sola comprobación off', () => {
      const c = doctorChecks(voice({ enabled: false })).filter((x) => x.area === 'voice');
      expect(c.map((x) => [x.id, x.status])).toEqual([['voice.enabled', 'off']]);
    });

    it('lista y en GPU: todo ok', () => {
      const v = byId(voice({ live: { lastNote: { device: 'gpu', at: 1 }, lastFailure: null } }));
      expect(v.get('voice.model')?.status).toBe('ok');
      expect(v.get('voice.device')).toMatchObject({
        status: 'ok',
        title: expect.stringMatching(/GPU/),
      });
      expect(v.has('voice.last')).toBe(false);
    });

    it('sin nota aún: el dispositivo no se sabe, y no es un problema', () => {
      expect(byId(voice()).get('voice.device')?.status).toBe('ok');
    });

    it('CPU con auto es aviso; con cpu configurado, no', () => {
      const cpu = { lastNote: { device: 'cpu' as const, at: 1 }, lastFailure: null };
      expect(byId(voice({ live: cpu })).get('voice.device')?.status).toBe('warn');
      expect(byId(voice({ device: 'cpu', live: cpu })).get('voice.device')?.status).toBe('ok');
      const unconfirmed = {
        lastNote: { device: 'unconfirmed' as const, at: 1 },
        lastFailure: null,
      };
      expect(byId(voice({ live: unconfirmed })).get('voice.device')?.status).toBe('warn');
    });

    it('modelo sin descargar: aviso con la orden; sin runtime: fallo', () => {
      const v = byId(voice({ model: 'missing', runtime: false }));
      expect(v.get('voice.model')).toMatchObject({ status: 'warn', fix: 'stratum voice download' });
      expect(v.get('voice.runtime')?.status).toBe('fail');
    });

    it('el último fallo solo cuenta si es posterior a la última nota buena', () => {
      const failed = { kind: 'load' as const, at: 5 };
      expect(
        byId(voice({ live: { lastNote: { device: 'gpu', at: 2 }, lastFailure: failed } })).get(
          'voice.last',
        )?.status,
      ).toBe('fail');
      expect(
        byId(voice({ live: { lastNote: { device: 'gpu', at: 9 }, lastFailure: failed } })).has(
          'voice.last',
        ),
      ).toBe(false);
    });

    it('sin daemon (live null) no se habla del dispositivo, y todo valida con el schema', () => {
      const c = doctorChecks(voice({ live: null }));
      expect(c.some((x) => x.id === 'voice.device')).toBe(false);
      for (const x of c) expect(doctorCheckSchema.parse(x)).toEqual(x);
    });
  });
});
