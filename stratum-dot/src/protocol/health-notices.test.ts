import { describe, expect, it } from 'vitest';
import { sampleHealthNotice } from '../testing/fixtures';
import { buildHealthNotice, healthNoticeEvents } from './health-notices';

/** M23 — qué avisar al sistema cuando el asistente se degrada (lógica pura). */

const notice = (n: unknown) => ({ type: 'health.notice', seq: 9, data: { notice: n } });

describe('healthNoticeEvents', () => {
  it('saca los `health.notice` que validan e ignora lo demás', () => {
    const events = healthNoticeEvents([
      notice(sampleHealthNotice()),
      notice(sampleHealthNotice({ cause: 'box:image' })),
      { type: 'health.notice', data: {} },
      notice({ cause: 'x' }),
      notice(sampleHealthNotice({ text: '' })),
      notice(sampleHealthNotice({ kind: 'other' as never })),
      { type: 'run.started', data: {} },
      null,
      'texto',
    ]);
    expect(events.map((n) => n.cause)).toEqual(['connector:google:credentials', 'box:image']);
  });
});

describe('buildHealthNotice', () => {
  it('el título depende de la clase y el área, y el cuerpo es el texto del daemon', () => {
    const text = 'Algo pasa.';
    const t = (o: Parameters<typeof sampleHealthNotice>[0]) => buildHealthNotice(sampleHealthNotice({ text, ...o }));
    expect(t({ kind: 'degraded', area: 'connectors' }).title).toBe('Assistant · a connector needs attention');
    expect(t({ kind: 'degraded', area: 'box', connector: null }).title).toBe('Assistant · the box needs attention');
    expect(t({ kind: 'recovered' }).title).toBe('Assistant · working again');
    expect(t({}).body).toBe(text);
  });

  it('la clave distingue causa, clase y momento', () => {
    const a = buildHealthNotice(sampleHealthNotice({ at: 1 }));
    const b = buildHealthNotice(sampleHealthNotice({ at: 2 }));
    expect(a.key).not.toBe(b.key);
    expect(a.key).toBe(buildHealthNotice(sampleHealthNotice({ at: 1 })).key);
  });
});
