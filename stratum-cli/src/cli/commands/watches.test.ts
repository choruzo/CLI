import { describe, expect, it, vi } from 'vitest';
import { ProtocolError } from '../../ipc/codec.js';
import type { ProtocolWatch, ProtocolWatchCheck } from '../../protocol/index.js';
import {
  describeCondition,
  describeError,
  formatChecks,
  formatWatchesList,
  parseWatchAddOptions,
  runAdd,
  runPause,
  runRemove,
  type WatchDeps,
} from './watches.js';

function watch(over: Partial<ProtocolWatch> = {}): ProtocolWatch {
  return {
    id: 'w1',
    name: 'Salon light',
    connector: 'home-assistant',
    check: 'ha_comprobar',
    args: { entity_id: 'light.salon' },
    condition: { kind: 'state-is', values: ['on', 'off'] },
    intervalSec: 300,
    cooldownMinutes: 30,
    notifyResolved: false,
    status: 'active',
    origin: 'person',
    createdAt: 1_700_000_000_000,
    firing: false,
    lastFiredAt: null,
    health: 'ok',
    ...over,
  };
}

function check(over: Partial<ProtocolWatchCheck> = {}): ProtocolWatchCheck {
  return {
    connector: 'home-assistant',
    connectorName: 'Home Assistant',
    connectorEnabled: true,
    tool: 'ha_comprobar',
    summary: 'State of an entity',
    minIntervalSec: 60,
    args: [
      { name: 'entity_id', type: 'string', required: true, description: 'Entity id' },
      {
        name: 'decimals',
        type: 'integer',
        required: false,
        description: 'Rounding',
        minimum: 0,
        maximum: 5,
      },
      { name: 'ratio', type: 'number', required: false, description: 'Ratio' },
      { name: 'strict', type: 'boolean', required: false, description: 'Strict mode' },
      { name: 'mode', type: 'string', required: false, description: 'Mode', enum: ['a', 'b'] },
    ],
    ...over,
  };
}

const base = { name: 'N', connector: 'home-assistant', check: 'ha_comprobar' };

describe('describeCondition', () => {
  it('cada tipo, con y sin duración', () => {
    expect(describeCondition({ kind: 'state-is', values: ['on', 'off'] })).toBe(
      'state is "on" or "off"',
    );
    expect(describeCondition({ kind: 'state-is-not', values: ['ok'] })).toBe('state is not "ok"');
    expect(describeCondition({ kind: 'above', threshold: 30 })).toBe('value above 30');
    expect(describeCondition({ kind: 'below', threshold: 5, forMinutes: 10 })).toBe(
      'value below 5 for at least 10 min',
    );
    expect(describeCondition({ kind: 'changes', forMinutes: 0 })).toBe('state changes');
  });
});

describe('formatWatchesList', () => {
  it('lista vacía', () => {
    expect(formatWatchesList({ watches: [] })).toBe('No watches.\n');
  });

  it('dos líneas por vigilante', () => {
    const out = formatWatchesList({ watches: [watch()] });
    expect(out).toContain('w1  active  Salon light');
    expect(out).toContain(
      '    home-assistant/ha_comprobar {"entity_id":"light.salon"} — state is "on" or "off" · every 300s · cooldown 30 min',
    );
    expect(out).not.toContain('firing');
  });

  it('cada marca', () => {
    const out = formatWatchesList({
      watches: [
        watch({
          notifyResolved: true,
          firing: true,
          health: 'failing',
          lastFiredAt: 1_700_000_000_000,
          origin: 'agent',
          status: 'paused',
        }),
        watch({ id: 'w2', health: 'suspended' }),
      ],
    });
    expect(out).toContain('w1  paused');
    expect(out).toContain('notifies when resolved');
    expect(out).toContain('firing');
    expect(out).toContain('failing (cannot check)');
    expect(out).toContain('last fired 2023-11-14T22:13:20.000Z');
    expect(out).toContain('by the assistant');
    expect(out).toContain('suspended');
  });
});

describe('formatChecks', () => {
  it('conector, mínimo y una línea por argumento', () => {
    const out = formatChecks([check(), check({ tool: 'x', connectorEnabled: false, args: [] })]);
    expect(out).toContain(
      'home-assistant/ha_comprobar (Home Assistant) — State of an entity · min every 60s',
    );
    expect(out).toContain('    entity_id: string, required — Entity id');
    expect(out).toContain('    decimals: integer, 0..5 — Rounding');
    expect(out).toContain('    mode: string, one of a|b — Mode');
    expect(out).toContain('home-assistant/x (Home Assistant, disabled)');
  });
});

describe('parseWatchAddOptions', () => {
  const checks = [check()];

  it('convierte los argumentos por su tipo declarado', () => {
    const r = parseWatchAddOptions(
      {
        ...base,
        arg: ['entity_id=light.salon', 'decimals=2', 'ratio=1.5', 'strict=true'],
        stateIs: 'on, off',
      },
      checks,
    );
    expect(r).toEqual({
      ok: true,
      params: {
        ...base,
        args: { entity_id: 'light.salon', decimals: 2, ratio: 1.5, strict: true },
        condition: { kind: 'state-is', values: ['on', 'off'] },
      },
    });
  });

  it('un valor con "=" conserva lo que sigue al primero', () => {
    const r = parseWatchAddOptions({ ...base, arg: ['entity_id=a=b'], changes: true }, checks);
    expect(r.ok && r.params.args).toEqual({ entity_id: 'a=b' });
  });

  it('rechaza clave no declarada, listando las declaradas', () => {
    const r = parseWatchAddOptions({ ...base, arg: ['nope=1'], changes: true }, checks);
    expect(r).toMatchObject({ ok: false });
    expect(!r.ok && r.error).toContain('entity_id, decimals');
  });

  it('rechaza valores que no valen para su tipo', () => {
    for (const arg of ['decimals=1.5', 'decimals=x', 'ratio=', 'strict=yes', 'sinigual']) {
      expect(parseWatchAddOptions({ ...base, arg: [arg], changes: true }, checks).ok).toBe(false);
    }
  });

  it('connector o check desconocido: lista los disponibles', () => {
    const r = parseWatchAddOptions({ ...base, check: 'otro', changes: true }, checks);
    expect(!r.ok && r.error).toContain('home-assistant/ha_comprobar');
    expect(parseWatchAddOptions({ ...base, connector: 'zz', changes: true }, checks).ok).toBe(
      false,
    );
  });

  it('exige nombre, connector y check', () => {
    expect(parseWatchAddOptions({ ...base, name: undefined, changes: true }, checks).ok).toBe(
      false,
    );
    expect(parseWatchAddOptions({ ...base, connector: undefined, changes: true }, checks).ok).toBe(
      false,
    );
    expect(parseWatchAddOptions({ ...base, check: undefined, changes: true }, checks).ok).toBe(
      false,
    );
  });

  it('exactamente una condición', () => {
    expect(parseWatchAddOptions({ ...base }, checks).ok).toBe(false);
    expect(parseWatchAddOptions({ ...base, changes: true, above: '3' }, checks).ok).toBe(false);
  });

  it('cada condición, con --for', () => {
    const cond = (o: object) => {
      const r = parseWatchAddOptions({ ...base, ...o }, checks);
      return r.ok ? r.params.condition : r;
    };
    expect(cond({ stateIsNot: 'ok', for: '5' })).toEqual({
      kind: 'state-is-not',
      values: ['ok'],
      forMinutes: 5,
    });
    expect(cond({ above: '30' })).toEqual({ kind: 'above', threshold: 30 });
    expect(cond({ below: '-2.5' })).toEqual({ kind: 'below', threshold: -2.5 });
    expect(cond({ changes: true })).toEqual({ kind: 'changes' });
  });

  it('rechaza números inválidos', () => {
    expect(parseWatchAddOptions({ ...base, above: 'abc' }, checks).ok).toBe(false);
    expect(parseWatchAddOptions({ ...base, above: 'Infinity' }, checks).ok).toBe(false);
    expect(parseWatchAddOptions({ ...base, changes: true, for: '-1' }, checks).ok).toBe(false);
    expect(parseWatchAddOptions({ ...base, changes: true, for: '1.5' }, checks).ok).toBe(false);
    expect(parseWatchAddOptions({ ...base, changes: true, cooldown: 'x' }, checks).ok).toBe(false);
  });

  it('--every acepta s, m y h', () => {
    const every = (e: string) => {
      const r = parseWatchAddOptions({ ...base, changes: true, every: e }, checks);
      return r.ok ? r.params.intervalSec : r;
    };
    expect(every('90')).toBe(90);
    expect(every('90s')).toBe(90);
    expect(every('5m')).toBe(300);
    expect(every('1h')).toBe(3600);
    expect(parseWatchAddOptions({ ...base, changes: true, every: '1d' }, checks).ok).toBe(false);
    expect(parseWatchAddOptions({ ...base, changes: true, every: '0' }, checks).ok).toBe(false);
  });

  it('cooldown y notify-resolved pasan; sin ellos no se envían', () => {
    const r = parseWatchAddOptions(
      { ...base, changes: true, cooldown: '0', notifyResolved: true },
      checks,
    );
    expect(r.ok && r.params).toMatchObject({ cooldownMinutes: 0, notifyResolved: true });
    const plain = parseWatchAddOptions({ ...base, changes: true }, checks);
    expect(plain.ok && Object.keys(plain.params).sort()).toEqual([
      'check',
      'condition',
      'connector',
      'name',
    ]);
  });
});

function makeDeps(over: Partial<WatchDeps> & { answer?: string } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const observer = {
    request: vi.fn(async () => ({ watches: [watch()], checks: [check()], readOnly: false })),
  };
  const authorityRequest = vi.fn(async () => ({ watch: watch() }));
  const close = vi.fn();
  const approver = vi.fn(async () => ({ request: authorityRequest, close }));
  const operatorRequest = vi.fn(async () => ({ watch: watch() }));
  const ask = vi.fn(async (_q: string) => over.answer ?? 'y');
  const deps = {
    observer,
    operator: { request: operatorRequest },
    approver,
    ask,
    isTTY: true,
    out: (t: string) => out.push(t),
    err: (t: string) => err.push(t),
    ...over,
  } as unknown as WatchDeps;
  return { deps, out, err, approver, authorityRequest, close, operatorRequest, ask };
}

const addOpts = { ...base, arg: ['entity_id=light.salon'], stateIs: 'on' };

describe('runAdd', () => {
  it('con "n" no abre el aprobador ni crea nada', async () => {
    const t = makeDeps({ answer: 'n' });
    expect(await runAdd(t.deps, addOpts)).toBe(false);
    expect(t.approver).not.toHaveBeenCalled();
    expect(t.authorityRequest).not.toHaveBeenCalled();
    expect(t.out.join('')).toContain('it runs nothing');
    expect(t.ask).toHaveBeenCalledWith('Create watch "N"? [y/N] ');
  });

  it('con "y" crea por la conexión del aprobador y la cierra', async () => {
    const t = makeDeps();
    expect(await runAdd(t.deps, addOpts)).toBe(true);
    expect(t.authorityRequest).toHaveBeenCalledWith('watches.add', {
      ...base,
      args: { entity_id: 'light.salon' },
      condition: { kind: 'state-is', values: ['on'] },
    });
    expect(t.operatorRequest).not.toHaveBeenCalled();
    expect(t.close).toHaveBeenCalled();
    expect(t.out.join('')).toContain('Created watch w1 (Salon light).');
  });

  it('sin terminal no pregunta ni crea', async () => {
    const t = makeDeps({ isTTY: false });
    expect(await runAdd(t.deps, addOpts)).toBe(false);
    expect(t.ask).not.toHaveBeenCalled();
    expect(t.approver).not.toHaveBeenCalled();
    expect(t.err.join('')).toContain('interactive terminal');
  });

  it('opciones inválidas: error y nada más', async () => {
    const t = makeDeps();
    expect(await runAdd(t.deps, { ...base })).toBe(false);
    expect(t.ask).not.toHaveBeenCalled();
  });

  it('sin aprobador (cancelado) no crea', async () => {
    const t = makeDeps({ approver: async () => null });
    expect(await runAdd(t.deps, addOpts)).toBe(false);
  });
});

describe('runPause / runRemove', () => {
  it('pause usa operator', async () => {
    const t = makeDeps();
    expect(await runPause(t.deps, 'w1')).toBe(true);
    expect(t.operatorRequest).toHaveBeenCalledWith('watches.pause', { watchId: 'w1' });
    expect(t.out.join('')).toContain('Paused w1 (Salon light).');
  });

  it('remove sin confirmar no llama', async () => {
    const t = makeDeps({ answer: 'n' });
    expect(await runRemove(t.deps, 'w1')).toBe(false);
    expect(t.operatorRequest).not.toHaveBeenCalled();
  });

  it('remove confirmado, o con --yes, llama', async () => {
    const t = makeDeps();
    expect(await runRemove(t.deps, 'w1')).toBe(true);
    expect(t.operatorRequest).toHaveBeenCalledWith('watches.remove', { watchId: 'w1' });
    const u = makeDeps({ isTTY: false });
    expect(await runRemove(u.deps, 'w1', { yes: true })).toBe(true);
    expect(u.ask).not.toHaveBeenCalled();
  });

  it('remove sin terminal y sin --yes no llama', async () => {
    const t = makeDeps({ isTTY: false });
    expect(await runRemove(t.deps, 'w1')).toBe(false);
    expect(t.operatorRequest).not.toHaveBeenCalled();
  });
});

describe('describeError', () => {
  it('explica los motivos de UNAVAILABLE', () => {
    expect(
      describeError(new ProtocolError('UNAVAILABLE', 'x', { reason: 'watches-disabled' })),
    ).toBe('Watches are not enabled in this daemon.');
    expect(describeError(new ProtocolError('UNAVAILABLE', 'x', { reason: 'read-only' }))).toContain(
      'newer Stratum or is damaged',
    );
    expect(describeError(new ProtocolError('INVALID_PARAMS', 'bad name'))).toBe('bad name');
  });
});
