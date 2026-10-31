import { describe, expect, it } from 'vitest';
import { sampleRoutine } from '../testing/fixtures';
import {
  NOTICE_SUMMARY_CHARS,
  NoticeLedger,
  buildRoutineNotice,
  routineRunEvents,
  shouldNotify,
} from './routine-notices';

/** M16 — cuándo y qué avisar al sistema de una rutina que terminó (lógica pura). */

const SID = 'ses_routine';
const run = (type: string, id = 'run_7') => ({ type, sessionId: SID, runId: id, seq: 4, data: { run: { id } } });

describe('routineRunEvents', () => {
  it('lee el inicio y el fin de un run, e ignora el resto', () => {
    const events = routineRunEvents(SID, [
      run('run.started'),
      { type: 'message.completed', data: { text: 'x' } },
      run('run.updated'),
      run('run.completed'),
      run('run.failed', 'run_8'),
      run('run.cancelled', 'run_9'),
      null,
      'texto',
      { type: 'run.completed', data: {} },
    ]);
    expect(events).toEqual([
      { sessionId: SID, runId: 'run_7', kind: 'started' },
      { sessionId: SID, runId: 'run_7', kind: 'completed' },
      { sessionId: SID, runId: 'run_8', kind: 'failed' },
      { sessionId: SID, runId: 'run_9', kind: 'cancelled' },
    ]);
  });

  it('si el evento no trae el run, vale su runId', () => {
    expect(routineRunEvents(SID, [{ type: 'run.completed', runId: 'run_3', data: {} }])).toEqual([
      { sessionId: SID, runId: 'run_3', kind: 'completed' },
    ]);
  });
});

describe('buildRoutineNotice', () => {
  const end = { sessionId: SID, runId: 'run_7', kind: 'completed' as const };

  it('título con el nombre y el estado; cuerpo, el resumen de ese run recortado', () => {
    const summary = `${'palabra '.repeat(60)}fin`;
    const routine = sampleRoutine({
      lastResult: { runId: 'run_7', sessionId: SID, status: 'completed', summary },
    });
    const notice = buildRoutineNotice(end, routine);
    expect(notice).toMatchObject({ routineId: routine.id, sessionId: SID, runId: 'run_7' });
    expect(notice.title).toBe('Morning summary finished');
    expect(notice.body.length).toBeLessThanOrEqual(NOTICE_SUMMARY_CHARS);
    expect(notice.body.endsWith('…')).toBe(true);
    expect(notice.body.startsWith('palabra palabra')).toBe(true);
  });

  it('un resultado fallido manda sobre el evento', () => {
    const routine = sampleRoutine({
      lastResult: { runId: 'run_7', sessionId: SID, status: 'failed', summary: 'No pude entrar' },
    });
    const notice = buildRoutineNotice(end, routine);
    expect(notice.title).toBe('Morning summary failed');
    expect(notice.body).toBe('No pude entrar');
  });

  it('sin resumen, el cuerpo es el estado', () => {
    const routine = sampleRoutine({ lastResult: { runId: 'run_7', sessionId: SID, status: 'completed', summary: null } });
    expect(buildRoutineNotice(end, routine).body).toBe('The run finished.');
    expect(buildRoutineNotice({ ...end, kind: 'cancelled' }, sampleRoutine()).body).toBe('The run was cancelled.');
  });

  it('nunca usa el resumen de otro run', () => {
    const routine = sampleRoutine({
      lastResult: { runId: 'run_OLD', sessionId: SID, status: 'completed', summary: 'Resumen de ayer' },
    });
    const notice = buildRoutineNotice({ ...end, kind: 'failed' }, routine);
    expect(notice.body).toBe('The run failed.');
    expect(notice.title).toBe('Morning summary failed');
  });
});

describe('shouldNotify y NoticeLedger', () => {
  it('no avisa con la ventana en primer plano y esa sesión delante', () => {
    expect(shouldNotify({ windowFocused: true, sessionOnScreen: true })).toBe(false);
    expect(shouldNotify({ windowFocused: true, sessionOnScreen: false })).toBe(true);
    expect(shouldNotify({ windowFocused: false, sessionOnScreen: true })).toBe(true);
    expect(shouldNotify({ windowFocused: false, sessionOnScreen: false })).toBe(true);
  });

  it('un run se avisa una sola vez, y el libro es acotado', () => {
    const ledger = new NoticeLedger(2);
    expect(ledger.take('a')).toBe(true);
    expect(ledger.take('a')).toBe(false);
    expect(ledger.take('b')).toBe(true);
    expect(ledger.take('c')).toBe(true);
    // 'a' ya se olvidó: el libro no crece sin límite.
    expect(ledger.take('a')).toBe(true);
    ledger.clear();
    expect(ledger.take('b')).toBe(true);
  });
});
