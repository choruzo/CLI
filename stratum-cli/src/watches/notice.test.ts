/**
 * M22 — el texto de un aviso de vigilante: plantilla fija, sin LLM, con el
 * nombre y el motivo neutralizados y un tope duro de caracteres.
 */
import { describe, expect, it } from 'vitest';
import type { CheckResult } from '../connectors/checks.js';
import { WATCH_LIMITS } from '../protocol/index.js';
import { watchNoticeText } from './notice.js';

const result = (estado: string, valor: number | null = null, detalle = ''): CheckResult => ({
  estado,
  valor,
  detalle,
});

describe('M22 — watchNoticeText', () => {
  it('fired: el nombre, la condición y lo que se está viendo ahora', () => {
    expect(
      watchNoticeText({
        kind: 'fired',
        name: 'Salón',
        condition: { kind: 'state-is', values: ['off'] },
        result: result('off', null, 'Luz del salón — off'),
      }),
    ).toBe('🔔 Vigilante «Salón»: el estado es «off». Ahora: «off» · Luz del salón — off.');
  });

  it('fired: el valor numérico solo cuando aporta algo', () => {
    expect(
      watchNoticeText({
        kind: 'fired',
        name: 'Temperatura',
        condition: { kind: 'above', threshold: 22 },
        result: result('caliente', 23.5),
      }),
    ).toBe('🔔 Vigilante «Temperatura»: el valor pasa de 22. Ahora: «caliente» (23.5).');
    // Si el estado ya es el número, no se repite entre paréntesis.
    expect(
      watchNoticeText({
        kind: 'fired',
        name: 'Temperatura',
        condition: { kind: 'above', threshold: 22 },
        result: result('23.5', 23.5),
      }),
    ).toBe('🔔 Vigilante «Temperatura»: el valor pasa de 22. Ahora: «23.5».');
    // Sin resultado (no debería pasar) no inventa el «Ahora».
    expect(
      watchNoticeText({
        kind: 'fired',
        name: 'Salón',
        condition: { kind: 'changes' },
      }),
    ).toBe('🔔 Vigilante «Salón»: el estado cambia.');
  });

  it('resolved: ya no se cumple, y con lo que se ve ahora', () => {
    expect(
      watchNoticeText({
        kind: 'resolved',
        name: 'Salón',
        condition: { kind: 'state-is', values: ['off'] },
        result: result('on'),
      }),
    ).toBe('✅ Vigilante «Salón»: ya no se cumple (el estado es «off»). Ahora: «on».');
  });

  it('failing y suspended: el motivo, sin el estado', () => {
    expect(
      watchNoticeText({
        kind: 'failing',
        name: 'Salón',
        condition: { kind: 'state-is', values: ['off'] },
        reason: 'the check returned no result',
      }),
    ).toBe('⚠️ El vigilante «Salón» no puede mirar: the check returned no result');
    expect(
      watchNoticeText({
        kind: 'suspended',
        name: 'Salón',
        condition: { kind: 'state-is', values: ['off'] },
        reason: 'the connectors box is stopped',
      }),
    ).toBe('⏸️ El vigilante «Salón» está suspendido: the connectors box is stopped');
    // Sin motivo ni nombre no se queda un hueco: lo dice.
    expect(watchNoticeText({ kind: 'failing', name: '', condition: { kind: 'changes' } })).toBe(
      '⚠️ El vigilante «sin nombre» no puede mirar: sin motivo',
    );
  });

  it('neutraliza el nombre: saltos de línea, controles y marcas de dirección', () => {
    const text = watchNoticeText({
      kind: 'suspended',
      name: 'Salón\nde la casa\u202Etahor\u0007',
      condition: { kind: 'changes' },
      reason: 'la caja no está en marcha',
    });
    expect(text).toBe(
      '⏸️ El vigilante «Salón de la casa tahor» está suspendido: la caja no está en marcha',
    );
    expect(text).not.toContain('\n');
    expect([...text].some((ch) => (ch.codePointAt(0) ?? 0) < 0x20)).toBe(false);
  });

  it('neutraliza también el motivo, que viene de fuera', () => {
    const text = watchNoticeText({
      kind: 'failing',
      name: 'Salón',
      condition: { kind: 'changes' },
      reason: 'timeout\r\nal leer el estado',
    });
    expect(text).toBe('⚠️ El vigilante «Salón» no puede mirar: timeout al leer el estado');
  });

  it(`un texto nunca pasa de ${WATCH_LIMITS.noticeChars} caracteres`, () => {
    const long = watchNoticeText({
      kind: 'fired',
      name: 'x'.repeat(WATCH_LIMITS.nameChars),
      condition: { kind: 'state-is', values: ['on'] },
      // Más largo que el tope que traería el conector: el aviso se corta igual.
      result: result('on', null, 'd'.repeat(WATCH_LIMITS.noticeChars)),
    });
    expect([...long].length).toBe(WATCH_LIMITS.noticeChars);
    expect(long.endsWith('…')).toBe(true);
    expect(long.startsWith('🔔 Vigilante «')).toBe(true);
  });
});
