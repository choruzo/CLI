import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApprovalGrants, type GrantChange } from './approval-grants.js';
import type { ProtocolResolver } from '../protocol/index.js';

const by: ProtocolResolver = { kind: 'remote', client: 'cli', connectionId: 3, at: 1 };
const MIN = 60_000;

describe('ApprovalGrants', () => {
  let mono: number;
  let wall: number;
  let grants: ApprovalGrants;
  let changes: GrantChange[];

  beforeEach(() => {
    vi.useFakeTimers();
    mono = 1_000;
    wall = 1_760_000_000_000;
    grants = new ApprovalGrants('ses_1', { now: () => wall, monotonic: () => mono });
    changes = [];
    grants.subscribe((c) => changes.push(c));
  });

  afterEach(() => {
    grants.clear();
    vi.useRealTimers();
  });

  it('crea, cubre la pareja tool + target y la lista', () => {
    const g = grants.create({ tool: 'exec', target: 'local' }, 10, by);
    expect(g).toMatchObject({
      sessionId: 'ses_1',
      tool: 'exec',
      target: 'local',
      minutes: 10,
      grantedAt: wall,
      expiresAt: wall + 10 * MIN,
      grantedBy: by,
    });
    expect(g.id).toMatch(/^grt_[0-9a-f]{16}$/);
    expect(grants.match('exec', 'local')).toEqual({
      id: g.id,
      minutes: 10,
      expiresAt: wall + 10 * MIN,
    });
    expect(grants.match('exec', 'ssh:prod')).toBeNull();
    expect(grants.match('write_file', 'local')).toBeNull();
    expect(grants.list()).toEqual([g]);
    expect(changes).toEqual([{ type: 'created', grant: g }]);
  });

  it('un target ausente no es lo mismo que uno presente', () => {
    const bare = grants.create({ tool: 'exec' }, 30, by);
    expect(bare).not.toHaveProperty('target');
    expect(grants.match('exec', undefined)?.id).toBe(bare.id);
    expect(grants.match('exec', 'local')).toBeNull();

    grants.create({ tool: 'exec', target: 'local' }, 30, by);
    expect(grants.list()).toHaveLength(2);
    expect(grants.match('exec', undefined)?.id).toBe(bare.id);
  });

  it('caduca con el reloj monotónico, la retira y avisa; el reloj de pared no la alarga', () => {
    grants.create({ tool: 'exec', target: 'local' }, 10, by);
    mono += 10 * MIN - 1;
    expect(grants.match('exec', 'local')).not.toBeNull();

    // Cambiar la hora del sistema no cambia nada.
    wall -= 24 * 60 * MIN;
    expect(grants.match('exec', 'local')).not.toBeNull();

    mono += 1;
    expect(grants.match('exec', 'local')).toBeNull();
    expect(grants.list()).toEqual([]);
    expect(changes.map((c) => c.type)).toEqual(['created', 'ended']);
    expect(changes[1]).toMatchObject({ type: 'ended', reason: 'expired' });
  });

  it('el temporizador avisa de la caducidad aunque nadie consulte', () => {
    grants.create({ tool: 'exec', target: 'local' }, 10, by);
    vi.advanceTimersByTime(10 * MIN);
    expect(changes.map((c) => c.type)).toEqual(['created', 'ended']);
    expect(changes[1]).toMatchObject({ reason: 'expired' });
    // Y no avisa dos veces.
    mono += 10 * MIN;
    expect(grants.match('exec', 'local')).toBeNull();
    expect(changes).toHaveLength(2);
  });

  it('list() retira las caducadas antes de contarlas', () => {
    grants.create({ tool: 'exec', target: 'local' }, 10, by);
    grants.create({ tool: 'write_file' }, 60, by);
    mono += 30 * MIN;
    expect(grants.list().map((g) => g.tool)).toEqual(['write_file']);
    expect(changes.filter((c) => c.type === 'ended')).toHaveLength(1);
  });

  it('renovar sustituye la anterior con id nuevo y sin avisar de que terminó la vieja', () => {
    const first = grants.create({ tool: 'exec', target: 'local' }, 10, by);
    mono += 5 * MIN;
    wall += 5 * MIN;
    const second = grants.create({ tool: 'exec', target: 'local' }, 30, by);
    expect(second.id).not.toBe(first.id);
    expect(grants.list()).toEqual([second]);
    expect(grants.match('exec', 'local')?.id).toBe(second.id);
    // Solo `created`: quien reduce la sustituye por tool + target.
    expect(changes.map((c) => c.type)).toEqual(['created', 'created']);

    // Cuenta desde la renovación, no suma; y el temporizador de la vieja no cuenta.
    vi.advanceTimersByTime(10 * MIN);
    expect(changes.map((c) => c.type)).toEqual(['created', 'created']);
    mono += 30 * MIN;
    expect(grants.match('exec', 'local')).toBeNull();
    expect(changes.at(-1)).toMatchObject({ type: 'ended', reason: 'expired' });
    expect(changes.filter((c) => c.type === 'ended')).toHaveLength(1);
  });

  it('revoke devuelve la concesión y avisa; revocar otra vez da null', () => {
    const g = grants.create({ tool: 'exec', target: 'local' }, 10, by);
    expect(grants.revoke(g.id)).toEqual(g);
    expect(grants.match('exec', 'local')).toBeNull();
    expect(changes.at(-1)).toMatchObject({ type: 'ended', reason: 'revoked' });
    expect(grants.revoke(g.id)).toBeNull();
    expect(grants.revoke('grt_nope')).toBeNull();
    expect(changes).toHaveLength(2);
  });

  it('revocar una ya caducada da null y se cuenta como caducada', () => {
    const g = grants.create({ tool: 'exec' }, 10, by);
    mono += 11 * MIN;
    expect(grants.revoke(g.id)).toBeNull();
    expect(changes.at(-1)).toMatchObject({ type: 'ended', reason: 'expired' });
  });

  it('deshabilitadas: match da null y create lanza', () => {
    const off = new ApprovalGrants('ses_2', { enabled: false });
    expect(off.enabled).toBe(false);
    expect(off.match('exec', 'local')).toBeNull();
    expect(() => off.create({ tool: 'exec', target: 'local' }, 10, by)).toThrow(/disabled/);
    expect(off.list()).toEqual([]);
  });

  it('clear retira todo sin avisar y cancela los temporizadores', () => {
    grants.create({ tool: 'exec', target: 'local' }, 10, by);
    grants.create({ tool: 'write_file' }, 30, by);
    grants.clear();
    expect(grants.list()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    expect(changes.map((c) => c.type)).toEqual(['created', 'created']);
  });

  it('un oyente que lanza no rompe a los demás', () => {
    grants.subscribe(() => {
      throw new Error('boom');
    });
    const seen: GrantChange[] = [];
    grants.subscribe((c) => seen.push(c));
    expect(() => grants.create({ tool: 'exec' }, 10, by)).not.toThrow();
    expect(seen).toHaveLength(1);
  });

  it('devuelve copias: mutar lo devuelto no toca la concesión', () => {
    const g = grants.create({ tool: 'exec' }, 10, by);
    g.tool = 'otra';
    expect(grants.list()[0]!.tool).toBe('exec');
  });
});
