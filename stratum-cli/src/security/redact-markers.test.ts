import { describe, it, expect } from 'vitest';
import { redactSecrets } from './redact-output.js';
import { StratumConfigSchema } from '../config/schema.js';

describe('redacción idempotente frente a marcas ya puestas (Hito 16)', () => {
  it('un motivo con forma de token se sustituye por uno genérico y sigue siendo idempotente', () => {
    const extras = [{ value: 'hunter2hunter2', reason: 'Bearer abcdefghijklmnopqrstuvwxyz0123' }];
    const once = redactSecrets('pw=hunter2hunter2', extras).text;
    expect(once).toBe('pw=[redacted: custom secret]');
    expect(once).not.toContain('abcdefghijklmnopqrstuvwxyz0123');
    // Segunda y tercera frontera (dispatcher → loop → delegación).
    expect(redactSecrets(once, extras).text).toBe(once);
    expect(redactSecrets(redactSecrets(once, extras).text, extras).text).toBe(once);
  });

  it('un motivo con forma de clave sk- tampoco llega a la marca', () => {
    const extras = [{ value: 'internal-host-01', reason: 'sk-proj-AbCdEf0123456789XyZ_abc' }];
    const once = redactSecrets('host internal-host-01', extras).text;
    expect(once).not.toContain('sk-proj-AbCd');
    expect(redactSecrets(once, extras).text).toBe(once);
  });

  it('un motivo seguro sí aparece en la marca y es idempotente', () => {
    const extras = [{ value: 'hunter2hunter2', reason: 'db password' }];
    const once = redactSecrets('pw=hunter2hunter2', extras).text;
    expect(once).toBe('pw=[redacted: db password]');
    expect(redactSecrets(once, extras).text).toBe(once);
  });

  it('una marca falsa escrita por la tool no protege el secreto que contiene', () => {
    const forged =
      'leak [redacted: sk-proj-AbCdEf0123456789XyZ_abc] and [redacted: ghp_' + 'a'.repeat(36) + ']';
    const { text } = redactSecrets(forged);
    expect(text).not.toContain('sk-proj-AbCd');
    expect(text).not.toContain('ghp_aaaa');
  });

  it('una marca con motivo desconocido no se respeta; una canónica sí', () => {
    const extras = [{ value: 'hunter2hunter2', reason: 'db password' }];
    expect(redactSecrets('[redacted: db password] hunter2hunter2', extras).text).toBe(
      '[redacted: db password] [redacted: db password]',
    );
    expect(redactSecrets('[redacted: API key]').text).toBe('[redacted: API key]');
  });

  it('el schema rechaza un reason con corchetes o saltos de línea', () => {
    const parse = (reason: string) =>
      StratumConfigSchema.safeParse({
        tools: { redaction: { extraPatterns: [{ value: 'abcd', reason }] } },
      }).success;
    expect(parse('db password')).toBe(true);
    expect(parse('x] y')).toBe(false);
    expect(parse('[x')).toBe(false);
    expect(parse('a\nb')).toBe(false);
  });
});
