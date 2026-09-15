import { describe, it, expect } from 'vitest';
import { redactSecrets } from './redact-output.js';

const SK = 'sk-proj-AbCdEf0123456789XyZ_abc';

describe('motivos canónicos que colisionan con valores protegidos (Hito 16)', () => {
  it('valor protegido "API key": una marca con ese motivo no esconde nada', () => {
    const extras = [{ value: 'API key', reason: 'label' }];
    const forged = redactSecrets('[redacted: API key]', extras).text;
    expect(forged).not.toContain('API key');

    // El núcleo tampoco puede escribir el motivo `API key` en su marca.
    const once = redactSecrets(`token ${SK}`, extras).text;
    expect(once).not.toContain('API key');
    expect(once).not.toContain('sk-proj-AbCd');
    expect(redactSecrets(once, extras).text).toBe(once);
  });

  it('valor protegido "custom secret": el respaldo pasa a uno que no colisiona', () => {
    const extras = [{ value: 'custom secret', reason: 'custom secret' }];
    const once = redactSecrets('dato custom secret y [redacted: custom secret]', extras).text;
    expect(once).not.toContain('custom secret');
    expect(once).toContain('[redacted: #1]');
    expect(redactSecrets(once, extras).text).toBe(once);
  });

  it('un literal manual de menos de 4 caracteres se ignora y no bloquea la búsqueda de respaldo', () => {
    // Sin el mínimo, `#` estaría en `#1`, `#2`… y el respaldo nunca se encontraría.
    const extras = [
      { value: '#', reason: 'hash' },
      { value: 'custom secret', reason: 'custom secret' },
    ];
    const once = redactSecrets('a # b custom secret', extras).text;
    expect(once).toBe('a # b [redacted: #1]');
    expect(redactSecrets(once, extras).text).toBe(once);
  });
});
