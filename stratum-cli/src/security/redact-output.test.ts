import { describe, it, expect } from 'vitest';
import { redactSecrets, redactText } from './redact-output.js';
import { StratumConfigSchema } from '../config/schema.js';

const JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';

describe('redactSecrets — núcleo (Hito 16)', () => {
  it('redacta un bloque PEM multilínea completo', () => {
    const pem = [
      'antes',
      '-----BEGIN OPENSSH PRIVATE KEY-----',
      'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW',
      '-----END OPENSSH PRIVATE KEY-----',
      'después',
    ].join('\n');
    const { text, hits } = redactSecrets(pem);
    expect(text).toBe('antes\n[redacted: private key]\ndespués');
    expect(hits).toEqual([{ id: 'private_key', count: 1 }]);
  });

  it('redacta un PEM cortado sin END hasta el final del texto', () => {
    const { text } = redactSecrets('x\n-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA');
    expect(text).toBe('x\n[redacted: private key]');
  });

  it('Authorization: Bearer produce una única marca y conserva la cabecera', () => {
    const { text, hits } = redactSecrets('Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123');
    expect(text).toBe('Authorization: Bearer [redacted: authorization header]');
    expect(hits.map((h) => h.id)).toEqual(['authorization_header']);
  });

  it('redacta un Bearer suelto conservando el esquema', () => {
    expect(redactSecrets('curl -H "x: Bearer abcdefghijklmnopqrstuvwxyz0123"').text).toBe(
      'curl -H "x: Bearer [redacted: bearer token]"',
    );
  });

  it('redacta JWT y claves sk- (proj y ant)', () => {
    const input = `jwt=${JWT} a=sk-proj-AbCdEf0123456789XyZ_abc b=sk-ant-api03-AbCdEf0123456789XyZ`;
    const { text } = redactSecrets(input);
    expect(text).not.toContain('eyJhbGci');
    expect(text).not.toContain('sk-proj-AbCd');
    expect(text).not.toContain('sk-ant-api03');
    expect(text).toContain('jwt=[redacted: JWT]');
  });

  it('redacta tokens de Slack y GitHub', () => {
    const { text } = redactSecrets(
      'xoxb-1234567890-abcdefghij ghp_' + 'a'.repeat(36) + ' github_pat_' + 'B'.repeat(30),
    );
    expect(text).toBe('[redacted: Slack token] [redacted: GitHub token] [redacted: GitHub token]');
  });

  it('no toca identificadores corrientes', () => {
    const benign = [
      'commit 3f786850e387550fdab836ed7e6dc881de23001b',
      'sha256 e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      'uuid 123e4567-e89b-12d3-a456-426614174000',
      'instance i-0abc1234def567890',
      'access key id AKIAIOSFODNN7EXAMPLE',
      'use a Bearer token in the header',
      'class sk-some-long-css-class-name-here',
    ].join('\n');
    expect(redactSecrets(benign)).toEqual({ text: benign, hits: [] });
  });

  it('es idempotente', () => {
    const once = redactSecrets(`t=${JWT} Authorization: Basic dXNlcjpwYXNzd29yZDEyMzQ=`).text;
    expect(redactSecrets(once).text).toBe(once);
  });

  it('1 MB de salida corriente se procesa en tiempo lineal', () => {
    const line = 'GET /api/v1/items?id=12345 200 12ms user=alice sk-short eyJ\n';
    const big = line.repeat(Math.ceil((1024 * 1024) / line.length));
    const start = performance.now();
    redactSecrets(big);
    expect(performance.now() - start).toBeLessThan(200);
  });
});

describe('redactSecrets — extras literales', () => {
  it('sustituye todas las ocurrencias y trata los caracteres de regex como texto', () => {
    const { text, hits } = redactSecrets('a=corp.(int)* b=corp.(int)*', [
      { value: 'corp.(int)*', reason: 'internal domain' },
    ]);
    expect(text).toBe('a=[redacted: internal domain] b=[redacted: internal domain]');
    expect(hits).toEqual([{ id: 'extra', count: 2 }]);
  });

  it('un literal que aparece dentro de una marca no la rompe: sigue siendo idempotente', () => {
    const extras = [
      { value: 'redacted', reason: 'custom' },
      { value: 'API key', reason: 'other' },
    ];
    const once = redactSecrets('a=sk-proj-AbCdEf0123456789XyZ_abc b=redacted', extras).text;
    // `API key` es aquí un valor protegido: la marca del núcleo no puede llevar
    // ese motivo y usa el respaldo, que no colisiona con ningún valor.
    expect(once).toBe('a=[redacted: custom secret] b=[redacted: custom]');
    expect(redactSecrets(once, extras).text).toBe(once);
  });

  it('redactText toma los extras de la config', () => {
    const config = StratumConfigSchema.parse({
      tools: { redaction: { extraPatterns: [{ value: 'hunter2hunter2', reason: 'db password' }] } },
    });
    expect(redactText('pw hunter2hunter2', config)).toBe('pw [redacted: db password]');
  });

  it('el schema rechaza extras vacíos, cortos, largos o demasiados', () => {
    const parse = (extraPatterns: unknown) =>
      StratumConfigSchema.safeParse({ tools: { redaction: { extraPatterns } } }).success;
    expect(parse([{ value: 'abc', reason: 'x' }])).toBe(false);
    expect(parse([{ value: 'a'.repeat(513), reason: 'x' }])).toBe(false);
    expect(parse([{ value: 'abcd', reason: '' }])).toBe(false);
    expect(parse(Array.from({ length: 51 }, () => ({ value: 'abcd', reason: 'x' })))).toBe(false);
    expect(parse([{ value: 'abcd', reason: 'x' }])).toBe(true);
  });
});
