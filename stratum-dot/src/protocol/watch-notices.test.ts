import { describe, expect, it } from 'vitest';
import { sampleWatchNotice } from '../testing/fixtures';
import { buildWatchNotice, watchNoticeEvents } from './watch-notices';

/** M22 — qué avisar al sistema cuando un vigilante habla (lógica pura). */

const notice = (n: unknown) => ({ type: 'watch.notice', seq: 9, data: { notice: n } });

describe('watchNoticeEvents', () => {
  it('saca los `watch.notice` que validan e ignora lo demás', () => {
    const events = watchNoticeEvents([
      notice(sampleWatchNotice()),
      notice(sampleWatchNotice({ watchId: 'wat_2' })),
      { type: 'watch.notice', data: {} },
      notice({ watchId: 'wat_3' }),
      notice(sampleWatchNotice({ text: '' })),
      notice(sampleWatchNotice({ kind: 'other' as never })),
      { type: 'run.started', data: {} },
      null,
      'texto',
    ]);
    expect(events.map((n) => n.watchId)).toEqual(['wat_abc1234567', 'wat_2']);
  });
});

describe('buildWatchNotice', () => {
  it('el título depende de la clase y el cuerpo es el texto del daemon', () => {
    const base = { name: 'Lluvia', text: 'Va a llover.' };
    expect(buildWatchNotice(sampleWatchNotice({ ...base, kind: 'fired' })).title).toBe('Watch · Lluvia');
    expect(buildWatchNotice(sampleWatchNotice({ ...base, kind: 'resolved' })).title).toBe('Watch resolved · Lluvia');
    expect(buildWatchNotice(sampleWatchNotice({ ...base, kind: 'failing' })).title).toBe(
      'Watch cannot check · Lluvia',
    );
    expect(buildWatchNotice(sampleWatchNotice({ ...base, kind: 'suspended' })).title).toBe(
      'Watch paused by Stratum · Lluvia',
    );
    expect(buildWatchNotice(sampleWatchNotice(base)).body).toBe('Va a llover.');
  });

  it('la clave distingue vigilante, clase y momento', () => {
    const a = buildWatchNotice(sampleWatchNotice({ at: 1 }));
    const b = buildWatchNotice(sampleWatchNotice({ at: 2 }));
    expect(a.key).not.toBe(b.key);
    expect(a.key).toBe(buildWatchNotice(sampleWatchNotice({ at: 1 })).key);
  });
});
