import { describe, expect, it } from 'vitest';
import { REVERT_LIMITS } from '../protocol/index.js';
import { RESULTS } from '../protocol/schemas.js';
import { protocolRevertPlan } from './hosted-session.js';

describe('protocolRevertPlan', () => {
  it('recorta cada lista al tope, marca truncated y el resultado cumple el contrato', () => {
    const many = Array.from({ length: REVERT_LIMITS.paths + 5 }, (_, i) => `f${i}.txt`);
    const plan = protocolRevertPlan({
      turns: [1, 2],
      restore: many,
      remove: ['b.txt'],
      conflicts: [],
      skipped: [],
    });
    expect(plan.restore).toHaveLength(REVERT_LIMITS.paths);
    expect(plan.restore[0]).toBe('f0.txt');
    expect(plan.remove).toEqual(['b.txt']);
    expect(plan.truncated).toBe(true);
    expect(RESULTS['sessions.revert'].safeParse({ status: 'planned', plan }).success).toBe(true);
  });

  it('sin listas largas no marca truncated ni comparte los arrays de entrada', () => {
    const restore = ['a.txt'];
    const plan = protocolRevertPlan({
      turns: [3],
      restore,
      remove: [],
      conflicts: [],
      skipped: [],
    });
    expect(plan.truncated).toBe(false);
    expect(plan.restore).not.toBe(restore);
  });
});
