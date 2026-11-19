import { describe, expect, it } from 'vitest';
import type { ToolContext } from '../../agent/types.js';
import type { ConnectorManifest } from '../../connectors/manifest.js';
import { defineWatch, type WatchDefinition } from '../../watches/define.js';
import { WatchStoreError } from '../../watches/store.js';
import { describeCall } from '../registry.js';
import {
  createProposeWatchTool,
  describeWatchProposal,
  PROPOSE_WATCH_TOOL,
  WATCH_PROPOSAL_DESCRIPTION_MAX,
  type WatchProposals,
} from './propose.js';

const ctx = {} as ToolContext;

const MANIFEST = {
  schemaVersion: 1,
  id: 'home-assistant',
  version: '1.1.0',
  name: 'Home Assistant',
  description: 'La casa',
  agents: ['companion'],
  hosts: [],
  secrets: [],
  tools: [{ name: 'ha_comprobar', readOnly: true, summary: 'estado' }],
  checks: [
    {
      tool: 'ha_comprobar',
      summary: 'estado de una entidad',
      minIntervalSec: 60,
      args: [
        { name: 'entity_id', type: 'string', required: true, description: 'entidad' },
        { name: 'nota', type: 'string', required: false, description: 'nota', maxLength: 500 },
      ],
    },
  ],
} as unknown as ConnectorManifest;

const ROUTINE_LIST: Record<string, { name: string; enabled: boolean }> = {
  rt_1: { name: 'Reiniciar WLED', enabled: true },
  rt_off: { name: 'Apagada', enabled: false },
};
const ROUTINES = { get: (id: string) => ROUTINE_LIST[id] };

const catalog = { get: (id: string) => (id === MANIFEST.id ? { manifest: MANIFEST } : undefined) };

function proposals(over: Partial<WatchProposals> = {}): WatchProposals & {
  created: WatchDefinition[];
} {
  const created: WatchDefinition[] = [];
  return {
    created,
    define: (r) => defineWatch({ ...r, origin: 'agent' }, catalog, ROUTINES),
    blocked: () => null,
    routine: (id) => ROUTINES.get(id),
    create: (d) => {
      created.push(d);
      return { id: 'wat_1', name: d.name };
    },
    ...over,
  };
}

const INPUT = {
  name: 'WLED caído',
  connector: 'home-assistant',
  check: 'ha_comprobar',
  args: { entity_id: 'light.wled' },
  condition: { kind: 'state-is', values: ['unavailable'], forMinutes: 5 },
  intervalSec: 60,
};

describe('M22 — propose_watch', () => {
  it('solo avisa: confirmación normal (destructiva), no forzada', () => {
    const t = createProposeWatchTool(proposals());
    expect(t.destructive).toBe(true);
    // Sin rutina no es forzada: allow-all y las concesiones valen como en cualquier tool.
    expect(t.confirmAlways?.(INPUT, ctx)).toBe(false);
  });

  it('quien aprueba ve el vigilante entero, con los valores por defecto ya puestos', () => {
    const text = describeCall({ id: 'c1', name: PROPOSE_WATCH_TOOL, input: INPUT });
    expect(text).toBe(
      'propose_watch: new watch "WLED caído" on connector "home-assistant", check ' +
        '"ha_comprobar" with {"entity_id":"light.wled"}. It fires when the state is ' +
        '"unavailable" for at least 5 min; checked every 60 s, at most one notice every 30 ' +
        'min. When it fires it only notifies you (Dot and Telegram); it runs nothing. It keeps ' +
        'checking on its own until you pause or remove it.',
    );
  });

  it('lo enseñado es exactamente lo que se guarda', async () => {
    const p = proposals();
    const t = createProposeWatchTool(p);
    expect(t.preflight?.(INPUT, ctx)).toBeNull();
    const r = await t.execute(INPUT, ctx);
    expect(r.ok).toBe(true);
    expect(p.created[0]).toEqual({
      name: 'WLED caído',
      connector: 'home-assistant',
      check: 'ha_comprobar',
      args: { entity_id: 'light.wled' },
      condition: { kind: 'state-is', values: ['unavailable'], forMinutes: 5 },
      intervalSec: 60,
      cooldownMinutes: 30,
      notifyResolved: false,
      origin: 'agent',
    });
  });

  it('la condición plana se cierra: los campos de otro kind se descartan', async () => {
    const p = proposals();
    const t = createProposeWatchTool(p);
    const input = { ...INPUT, condition: { kind: 'below', threshold: 10, values: ['x'] } };
    expect(t.preflight?.(input, ctx)).toBeNull();
    await t.execute(input, ctx);
    expect(p.created[0]!.condition).toEqual({ kind: 'below', threshold: 10 });
  });

  it('lo que no vale contra el catálogo se dice en preflight, antes de preguntar', () => {
    const t = createProposeWatchTool(proposals());
    const veto = (input: Record<string, unknown>) => t.preflight?.(input, ctx);
    expect(veto({ ...INPUT, check: 'otra' })).toMatchObject({
      ok: false,
      recoverable: true,
      error: expect.stringContaining('its checks: ha_comprobar'),
    });
    expect(veto({ ...INPUT, connector: 'nada' })).toMatchObject({ ok: false });
    expect(veto({ ...INPUT, args: {} })).toMatchObject({ ok: false });
    expect(veto({ ...INPUT, intervalSec: 30 })).toMatchObject({ ok: false });
    expect(veto({ ...INPUT, condition: { kind: 'above' } })).toMatchObject({ ok: false });
  });

  it('un nombre con controles no se enseña distinto de como se guarda: veto', () => {
    const t = createProposeWatchTool(proposals());
    const veto = t.preflight?.({ ...INPUT, name: 'WLED‮odíac' }, ctx);
    expect(veto).toMatchObject({ ok: false, error: expect.stringContaining('cannot be shown') });
  });

  it('si no cabe entero en una solicitud, no se pregunta', () => {
    const t = createProposeWatchTool(proposals());
    // Cada parte vale por sí sola, pero juntas no caben en la descripción.
    const long = {
      ...INPUT,
      args: { entity_id: 'e'.repeat(400), nota: 'n'.repeat(500) },
      condition: {
        kind: 'state-is',
        values: Array.from({ length: 10 }, (_, i) => `${i}`.padEnd(64, 'x')),
      },
    };
    expect(describeWatchProposal(long).length).toBeGreaterThan(WATCH_PROPOSAL_DESCRIPTION_MAX);
    expect(t.preflight?.(long, ctx)).toMatchObject({
      ok: false,
      error: expect.stringContaining('too long to show in full'),
    });
    // Con la descripción al tope, siempre cabe en INPUT_CHARS (2 000) del publicador.
    expect(WATCH_PROPOSAL_DESCRIPTION_MAX).toBeLessThanOrEqual(2_000);
  });

  it('bloqueado (solo lectura o tope) se dice antes de preguntar', () => {
    const t = createProposeWatchTool(proposals({ blocked: () => 'there are already 20 watches.' }));
    expect(t.preflight?.(INPUT, ctx)).toMatchObject({
      ok: false,
      error: 'The watch cannot be created: there are already 20 watches.',
    });
  });

  it('un error del almacén al crear vuelve al modelo como recuperable', async () => {
    const t = createProposeWatchTool(
      proposals({
        create: () => {
          throw new WatchStoreError('read-only', 'cannot be modified');
        },
      }),
    );
    expect(await t.execute(INPUT, ctx)).toMatchObject({ ok: false, recoverable: true });
  });

  it('describeWatchProposal no lanza con una entrada rara', () => {
    expect(() => describeWatchProposal({ name: 3, condition: null })).not.toThrow();
  });

  describe('fase 4 — lanzar una rutina', () => {
    const WITH = { ...INPUT, routineId: 'rt_1', routineName: 'Reiniciar WLED' };

    it('con rutina, la confirmación es forzada; sin ella, normal', () => {
      const t = createProposeWatchTool(proposals());
      expect(t.confirmAlways?.(WITH, ctx)).toBe(true);
      expect(t.confirmAlways?.(INPUT, ctx)).toBe(false);
    });

    it('quien aprueba ve que corre la rutina, con su nombre e id', () => {
      const text = describeCall({ id: 'c1', name: PROPOSE_WATCH_TOOL, input: WITH });
      expect(text).toContain('RUNS YOUR ROUTINE "Reiniciar WLED" (rt_1) on its own');
      expect(text).not.toContain('it runs nothing');
    });

    it('guarda el routineId', async () => {
      const p = proposals();
      const t = createProposeWatchTool(p);
      expect(t.preflight?.(WITH, ctx)).toBeNull();
      await t.execute(WITH, ctx);
      expect(p.created[0]!.routineId).toBe('rt_1');
    });

    it('un nombre que no es el de esa rutina, una que no existe o una deshabilitada: veto', () => {
      const t = createProposeWatchTool(proposals());
      const veto = (input: Record<string, unknown>) => t.preflight?.(input, ctx);
      expect(veto({ ...WITH, routineName: 'Otra' })).toMatchObject({
        ok: false,
        error: expect.stringContaining('"Reiniciar WLED"'),
      });
      expect(veto({ ...WITH, routineId: 'rt_nada' })).toMatchObject({ ok: false });
      expect(veto({ ...WITH, routineId: 'rt_off', routineName: 'Apagada' })).toMatchObject({
        ok: false,
        error: expect.stringContaining('disabled'),
      });
      expect(veto({ ...INPUT, routineName: 'Reiniciar WLED' })).toMatchObject({ ok: false });
      expect(veto({ ...WITH, routineName: undefined })).toMatchObject({ ok: false });
    });
  });
});
