import { describe, it, expect } from 'vitest';
import { redactSecrets } from './redact-output.js';
import { unsafeReasonProblem } from './secrets.js';
import { StratumConfigSchema } from '../config/schema.js';

function parses(extraPatterns: Array<{ value: string; reason: string }>): boolean {
  return StratumConfigSchema.safeParse({ tools: { redaction: { extraPatterns } } }).success;
}

describe('motivos de redacción seguros (Hito 16)', () => {
  it('el schema rechaza un reason igual al value que protege', () => {
    expect(parses([{ value: 'hunter2hunter2', reason: 'hunter2hunter2' }])).toBe(false);
  });

  it('el schema rechaza un reason que contiene el value de OTRA entrada', () => {
    expect(
      parses([
        { value: 'hunter2hunter2', reason: 'db password' },
        { value: 'internal-host-01', reason: 'host hunter2hunter2' },
      ]),
    ).toBe(false);
  });

  it('el schema rechaza un reason con forma de secreto del núcleo', () => {
    expect(parses([{ value: 'abcd1234', reason: 'sk-proj-AbCdEf0123456789XyZ_abc' }])).toBe(false);
    expect(parses([{ value: 'abcd1234', reason: 'db password' }])).toBe(true);
  });

  it('una config construida a mano con un reason inseguro no crea un escondite ni lo filtra', () => {
    const extras = [{ value: 'hunter2hunter2', reason: 'hunter2hunter2' }];
    expect(unsafeReasonProblem('hunter2hunter2', ['hunter2hunter2'])).not.toBeNull();
    // La tool escribe la «marca» con el secreto dentro, y además el secreto en claro.
    const { text } = redactSecrets('[redacted: hunter2hunter2] y en claro hunter2hunter2', extras);
    expect(text).not.toContain('hunter2hunter2');
    expect(text).toContain('[redacted: custom secret]');
    expect(redactSecrets(text, extras).text).toBe(text);
  });
});
