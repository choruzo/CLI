import { describe, expect, it } from 'vitest';
import type { ProtocolRoutine } from '../../protocol/index.js';
import {
  describeError,
  formatLocalTime,
  formatRoutinesTable,
  lastLabel,
  nextLabel,
  resolveRoutine,
} from './routines.js';
import { ProtocolError } from '../../ipc/codec.js';

const AT = new Date(2026, 9, 31, 18, 5).getTime();

function routine(overrides: Partial<ProtocolRoutine> = {}): ProtocolRoutine {
  return {
    id: 'rt_abc',
    name: 'Resumen',
    schedule: '1h',
    prompt: 'p',
    enabled: true,
    createdAt: AT,
    nextFireAt: AT,
    scheduleError: null,
    sessionId: null,
    running: false,
    lastFire: null,
    lastResult: null,
    ...overrides,
  };
}

describe('stratum routines — formato', () => {
  it('sin rutinas lo dice', () => {
    expect(formatRoutinesTable([])).toBe('No routines.\n');
  });

  it('formatea la hora local sin segundos', () => {
    expect(formatLocalTime(AT)).toBe('2026-10-31 18:05');
  });

  it('una fila por rutina con cabecera y siguiente vencimiento local', () => {
    const lines = formatRoutinesTable([
      routine(),
      routine({ id: 'rt_def', name: 'Otra', enabled: false }),
    ])
      .trimEnd()
      .split('\n');
    expect(lines[0]).toMatch(/^NAME\s+ID\s+SCHEDULE\s+ENABLED\s+NEXT\s+LAST$/);
    expect(lines[1]).toMatch(/^Resumen\s+rt_abc\s+1h\s+yes\s+2026-10-31 18:05\s+-$/);
    expect(lines[2]).toMatch(/^Otra\s+rt_def\s+1h\s+no\s+disabled\s+-$/);
  });

  it('NEXT explica un horario inservible y LAST el último resultado', () => {
    expect(nextLabel(routine({ nextFireAt: null, scheduleError: 'bad' }))).toBe('invalid: bad');
    expect(lastLabel(routine({ running: true }))).toBe('running');
    expect(
      lastLabel(
        routine({
          lastResult: { runId: 'r', sessionId: 's', status: 'failed', endedAt: AT, summary: null },
        }),
      ),
    ).toBe('failed 2026-10-31 18:05');
    expect(lastLabel(routine({ lastFire: { at: AT, outcome: 'missed', manual: false } }))).toBe(
      'missed 2026-10-31 18:05',
    );
    expect(lastLabel(routine({ lastFire: { at: AT, outcome: 'started', manual: false } }))).toBe(
      '-',
    );
  });
});

describe('stratum routines — resolución id/nombre', () => {
  const routines = [routine(), routine({ id: 'rt_def', name: 'Otra' })];

  it('por id', () => {
    expect(resolveRoutine(routines, 'rt_def')).toMatchObject({
      ok: true,
      routine: { name: 'Otra' },
    });
  });

  it('por nombre exacto, sin mayúsculas', () => {
    expect(resolveRoutine(routines, 'resumen')).toMatchObject({
      ok: true,
      routine: { id: 'rt_abc' },
    });
    expect(resolveRoutine(routines, 'RESUMEN')).toMatchObject({ ok: true });
  });

  it('no hay coincidencia parcial ni desconocida', () => {
    expect(resolveRoutine(routines, 'resu')).toMatchObject({ ok: false });
    expect(resolveRoutine(routines, 'nope')).toMatchObject({ ok: false });
  });

  it('el id gana a un nombre igual a otro id y un nombre repetido pide el id', () => {
    const twins = [routine({ id: 'a', name: 'x' }), routine({ id: 'b', name: 'X' })];
    expect(resolveRoutine(twins, 'x')).toMatchObject({ ok: false });
    expect(resolveRoutine(twins, 'a')).toMatchObject({ ok: true, routine: { id: 'a' } });
  });
});

describe('stratum routines — errores', () => {
  it('un error con issues se dice por campo; sin ellos, su mensaje', () => {
    expect(
      describeError(
        new ProtocolError('INVALID_PARAMS', 'Invalid params', {
          issues: [{ path: 'schedule', message: 'unknown schedule' }],
        }),
      ),
    ).toBe('schedule: unknown schedule');
    expect(describeError(new ProtocolError('NOT_FOUND', 'Routine not found.'))).toBe(
      'Routine not found.',
    );
  });
});
