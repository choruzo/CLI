import { describe, expect, it } from 'vitest';
import { recentSessionRows, relativeTime, shortPath } from './banner-info.js';

const NOW = Date.parse('2026-10-28T18:00:00Z');
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();

describe('banner-info', () => {
  it('tiempo relativo', () => {
    expect(relativeTime(ago(0), NOW)).toBe('ahora');
    expect(relativeTime(ago(5), NOW)).toBe('hace 5 min');
    expect(relativeTime(ago(180), NOW)).toBe('hace 3 h');
    expect(relativeTime(ago(26 * 60), NOW)).toBe('ayer');
    expect(relativeTime(ago(4 * 24 * 60), NOW)).toBe('hace 4 días');
    expect(relativeTime('no', NOW)).toBe('');
  });

  it('recientes: sin la actual ni las vacías; resumen o primer mensaje', () => {
    const rows = recentSessionRows(
      [
        { id: 'actual', updatedAt: ago(1), summary: 'x' },
        { id: 'vacia', updatedAt: ago(2), summary: '', messages: [] },
        { id: 'a', updatedAt: ago(3), summary: 'Arreglar el login' },
        {
          id: 'b',
          updatedAt: ago(90),
          summary: '',
          messages: [
            { role: 'system', content: 'sys' },
            { role: 'user', content: 'revisa\nel   build' },
          ],
        },
      ],
      'actual',
      NOW,
    );
    expect(rows).toEqual([
      { id: 'a', when: 'hace 3 min', title: 'Arreglar el login' },
      { id: 'b', when: 'hace 1 h', title: 'revisa el build' },
    ]);
  });

  it('carpeta acortada por la izquierda', () => {
    expect(shortPath('D:\\a\\b', 20)).toBe('D:\\a\\b');
    expect(shortPath('D:\\Archivos\\Javier\\Proyectos\\CLI', 18)).toBe('…\\Proyectos\\CLI');
    expect(shortPath('/home/u/proyectos/cli', 15)).toBe('…/proyectos/cli');
    expect(shortPath('/home/u/proyectos/cli', 14)).toBe('…/cli');
  });
});
