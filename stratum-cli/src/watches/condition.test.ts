/**
 * M22 — la condición de un vigilante: qué la cumple y cómo se cuenta en una
 * frase. Sin I/O y sin estado: lo demás es de `engine.ts`.
 */
import { describe, expect, it } from 'vitest';
import { WATCH_LIMITS } from '../protocol/index.js';
import { CHECK_STATE_MAX, type CheckResult } from '../connectors/checks.js';
import {
  WatchConditionSchema,
  conditionHolds,
  describeCondition,
  type WatchCondition,
} from './condition.js';

const result = (estado: string, valor: number | null = null, detalle = ''): CheckResult => ({
  estado,
  valor,
  detalle,
});

const holds = (condition: WatchCondition, r: CheckResult): boolean | null =>
  conditionHolds(condition as Exclude<WatchCondition, { kind: 'changes' }>, r);

describe('M22 — conditionHolds', () => {
  it('state-is: el estado es uno de los valores', () => {
    const c: WatchCondition = { kind: 'state-is', values: ['on', 'home'] };
    expect(holds(c, result('on'))).toBe(true);
    expect(holds(c, result('home'))).toBe(true);
    expect(holds(c, result('off'))).toBe(false);
    // Compara el estado neutralizado, no el detalle.
    expect(holds(c, result('off', null, 'on'))).toBe(false);
  });

  it('state-is-not: el estado no es ninguno de los valores', () => {
    const c: WatchCondition = { kind: 'state-is-not', values: ['closed'] };
    expect(holds(c, result('closed'))).toBe(false);
    expect(holds(c, result('open'))).toBe(true);
  });

  it('above / below: el valor pasa el umbral', () => {
    expect(holds({ kind: 'above', threshold: 20 }, result('x', 21))).toBe(true);
    expect(holds({ kind: 'above', threshold: 20 }, result('x', 20))).toBe(false);
    expect(holds({ kind: 'below', threshold: 20 }, result('x', 19))).toBe(true);
    expect(holds({ kind: 'below', threshold: 20 }, result('x', 20))).toBe(false);
    // El borde no cuenta: «pasa de» y «baja de» son estrictos.
    expect(holds({ kind: 'above', threshold: 0 }, result('x', 0))).toBe(false);
  });

  it('un umbral sin valor numérico no se puede saber (ni sí ni no)', () => {
    expect(holds({ kind: 'above', threshold: 20 }, result('desconocido'))).toBeNull();
    expect(holds({ kind: 'below', threshold: 20 }, result('desconocido'))).toBeNull();
    // Un estado sí se sabe siempre, aunque no haya valor.
    expect(holds({ kind: 'state-is', values: ['off'] }, result('off'))).toBe(true);
  });
});

describe('M22 — WatchConditionSchema', () => {
  it('valida las cinco formas cerradas', () => {
    for (const c of [
      { kind: 'state-is', values: ['on'] },
      { kind: 'state-is-not', values: ['on'] },
      { kind: 'above', threshold: 1 },
      { kind: 'below', threshold: 1 },
      { kind: 'changes' },
    ]) {
      expect(WatchConditionSchema.parse(c)).toEqual(c);
    }
  });

  it('admite «durante al menos N minutos» de 0 a maxForMinutes', () => {
    expect(WatchConditionSchema.parse({ kind: 'changes', forMinutes: 0 }).forMinutes).toBe(0);
    expect(
      WatchConditionSchema.parse({ kind: 'changes', forMinutes: WATCH_LIMITS.maxForMinutes })
        .forMinutes,
    ).toBe(WATCH_LIMITS.maxForMinutes);
    expect(WatchConditionSchema.safeParse({ kind: 'changes', forMinutes: -1 }).success).toBe(false);
    expect(
      WatchConditionSchema.safeParse({
        kind: 'changes',
        forMinutes: WATCH_LIMITS.maxForMinutes + 1,
      }).success,
    ).toBe(false);
    expect(WatchConditionSchema.safeParse({ kind: 'changes', forMinutes: 1.5 }).success).toBe(
      false,
    );
  });

  it('rechaza un tipo inventado, valores vacíos, de más o con campos extra', () => {
    expect(WatchConditionSchema.safeParse({ kind: 'equals', values: ['on'] }).success).toBe(false);
    expect(WatchConditionSchema.safeParse({ kind: 'state-is', values: [] }).success).toBe(false);
    expect(
      WatchConditionSchema.safeParse({
        kind: 'state-is',
        values: Array.from({ length: WATCH_LIMITS.stateValues + 1 }, (_, i) => `v${i}`),
      }).success,
    ).toBe(false);
    expect(WatchConditionSchema.safeParse({ kind: 'state-is', values: ['   '] }).success).toBe(
      false,
    );
    expect(
      WatchConditionSchema.safeParse({
        kind: 'state-is',
        values: ['x'.repeat(CHECK_STATE_MAX + 1)],
      }).success,
    ).toBe(false);
    // Estricto: ni `forMinutes` en un sitio raro ni un campo de más.
    expect(
      WatchConditionSchema.safeParse({ kind: 'above', threshold: 1, values: ['x'] }).success,
    ).toBe(false);
    expect(WatchConditionSchema.safeParse({ kind: 'changes', threshold: 1 }).success).toBe(false);
    expect(WatchConditionSchema.safeParse({ kind: 'changes', valor: 1 }).success).toBe(false);
  });

  it('desconoce `changes` en conditionHolds: depende del estado anterior', () => {
    // El motor la trata antes de llegar aquí; el tipo lo impide en compilación.
    const changes = { kind: 'changes' } as unknown as Exclude<WatchCondition, { kind: 'changes' }>;
    expect(conditionHolds(changes, result('on'))).toBeUndefined();
  });
});

describe('M22 — describeCondition', () => {
  it('cuenta cada condición en una frase', () => {
    expect(describeCondition({ kind: 'state-is', values: ['off'] })).toBe('el estado es «off»');
    expect(describeCondition({ kind: 'state-is', values: ['on', 'home'] })).toBe(
      'el estado es «on» o «home»',
    );
    expect(describeCondition({ kind: 'state-is', values: ['a', 'b', 'c'] })).toBe(
      'el estado es «a», «b» o «c»',
    );
    expect(describeCondition({ kind: 'state-is-not', values: ['closed'] })).toBe(
      'el estado no es «closed»',
    );
    expect(describeCondition({ kind: 'above', threshold: 22 })).toBe('el valor pasa de 22');
    expect(describeCondition({ kind: 'below', threshold: 5 })).toBe('el valor baja de 5');
    expect(describeCondition({ kind: 'changes' })).toBe('el estado cambia');
  });

  it('añade «durante al menos N min» solo cuando hay minutos', () => {
    expect(describeCondition({ kind: 'changes', forMinutes: 5 })).toBe(
      'el estado cambia durante al menos 5 min',
    );
    expect(describeCondition({ kind: 'state-is', values: ['off'], forMinutes: 0 })).toBe(
      'el estado es «off»',
    );
  });
});
