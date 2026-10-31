import { describe, expect, it } from 'vitest';
import type { ToolContext } from '../../agent/types.js';
import { RoutineStoreError } from '../../routines/store.js';
import { describeCall } from '../registry.js';
import {
  createProposeRoutineTool,
  describeRoutineProposal,
  PROPOSE_ROUTINE_TOOL,
  PROPOSED_PROMPT_MAX_CHARS,
  PROPOSED_SCHEDULE_MAX_CHARS,
  type RoutineProposal,
} from './propose.js';

const ctx = {} as ToolContext;
const LONG_PROMPT = 'Revisa el correo y resume lo urgente. '.repeat(40).trim();

function tool(create: (p: RoutineProposal) => ReturnType<typeof okCreate> = okCreate) {
  return createProposeRoutineTool({ create });
}
function okCreate(p: RoutineProposal) {
  return { id: 'rt_1', name: p.name, nextFireAt: Date.UTC(2026, 10, 1, 9) };
}

describe('M16 — propose_routine', () => {
  it('siempre pide confirmación forzada: ni allow-all ni confirmDestructive: false la saltan', () => {
    const t = tool();
    expect(t.destructive).toBe(true);
    expect(t.confirmAlways?.({}, ctx)).toBe(true);
  });

  it('quien aprueba ve el prompt entero (no el resumen de 120) y cabe en una solicitud', () => {
    const input = {
      name: 'Correo',
      schedule: '0 9 * * 1-5',
      prompt: LONG_PROMPT,
      timeoutMinutes: 5,
    };
    const text = describeCall({ id: 'c1', name: PROPOSE_ROUTINE_TOOL, input });
    expect(text).toContain(LONG_PROMPT);
    expect(text).toContain('"0 9 * * 1-5"');
    expect(text).toContain('timeout 5 min');
    expect(text).toContain('nobody watching');
    const worst = describeRoutineProposal({
      name: 'x'.repeat(80),
      schedule: 'y'.repeat(PROPOSED_SCHEDULE_MAX_CHARS),
      prompt: 'z'.repeat(PROPOSED_PROMPT_MAX_CHARS),
      maxIterations: 200,
      timeoutMinutes: 1440,
    });
    // INPUT_CHARS del publicador (2 000): la solicitud nunca recorta el prompt.
    expect(worst.length).toBeLessThanOrEqual(2_000);
  });

  it('describeRoutineProposal no lanza con una entrada rara', () => {
    expect(() => describeRoutineProposal({ name: 3, prompt: null })).not.toThrow();
  });

  it('un horario que no vale se dice en preflight, antes de preguntar a nadie', () => {
    const t = tool();
    const veto = t.preflight?.({ name: 'a', schedule: 'cada lunes', prompt: 'p' }, ctx);
    expect(veto).toMatchObject({ ok: false, recoverable: true, countsAsFailure: false });
    expect(t.preflight?.({ name: 'a', schedule: '2h', prompt: 'p' }, ctx)).toBeNull();
  });

  it('el schema acota el prompt', () => {
    const r = tool().schema.safeParse({
      name: 'a',
      schedule: '1h',
      prompt: 'p'.repeat(PROPOSED_PROMPT_MAX_CHARS + 1),
    });
    expect(r.success).toBe(false);
  });

  it('aprobada, crea la rutina con sus límites', async () => {
    const seen: RoutineProposal[] = [];
    const t = tool((p) => {
      seen.push(p);
      return okCreate(p);
    });
    const r = await t.execute(
      { name: 'Correo', schedule: '1d', prompt: 'resume', maxIterations: 10 },
      ctx,
    );
    expect(r).toMatchObject({ ok: true });
    expect(r.ok && r.output).toContain('rt_1');
    expect(seen).toEqual([
      { name: 'Correo', schedule: '1d', prompt: 'resume', limits: { maxIterations: 10 } },
    ]);
  });

  it('un error del almacén (nombre repetido, solo lectura) es recuperable', async () => {
    const t = tool(() => {
      throw new RoutineStoreError('duplicate-name', 'A routine named "Correo" already exists.');
    });
    const r = await t.execute({ name: 'Correo', schedule: '1d', prompt: 'resume' }, ctx);
    expect(r).toMatchObject({ ok: false, recoverable: true });
  });
});
