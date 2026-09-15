import { describe, it, expect } from 'vitest';
import { parseTarget, resolveTarget, formatTarget, escapeXmlAttr } from './target.js';
import { StratumConfigSchema } from '../../config/schema.js';

describe('parseTarget (Hito 16)', () => {
  it('sin target o "local" → local', () => {
    expect(parseTarget()).toEqual({ ok: true, target: { kind: 'local' } });
    expect(parseTarget('  ')).toEqual({ ok: true, target: { kind: 'local' } });
    expect(parseTarget('local')).toEqual({ ok: true, target: { kind: 'local' } });
  });

  it('ssh:<alias>', () => {
    expect(parseTarget('ssh:prod-web')).toEqual({
      ok: true,
      target: { kind: 'ssh', alias: 'prod-web' },
    });
  });

  it('ssh sin alias es un error', () => {
    const r = parseTarget('ssh:');
    expect(r.ok).toBe(false);
  });

  it('los kinds reservados se rechazan con un mensaje que lista los disponibles', () => {
    for (const raw of ['container:docker/abc', 'pod:ctx/ns/name', 'winrm:dc1']) {
      const r = parseTarget(raw);
      expect(r.ok).toBe(false);
      expect(!r.ok && r.error).toContain('not available yet');
      expect(!r.ok && r.error).toContain('ssh:<alias>');
    }
  });

  it('un kind desconocido se rechaza', () => {
    expect(parseTarget('ftp:x').ok).toBe(false);
  });
});

describe('resolveTarget', () => {
  const config = StratumConfigSchema.parse({
    ssh: { hosts: { dev: { host: 'h', user: 'u', password: 'p' } } },
  });

  it('local siempre existe', () => {
    expect(resolveTarget({ kind: 'local' }, config)).toEqual({ ok: true });
  });

  it('un alias del inventario existe; uno desconocido lista los disponibles', () => {
    expect(resolveTarget({ kind: 'ssh', alias: 'dev' }, config)).toEqual({ ok: true });
    const r = resolveTarget({ kind: 'ssh', alias: 'nope' }, config);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain('dev');
  });
});

describe('formatTarget / escapeXmlAttr', () => {
  it('formatea y escapa', () => {
    expect(formatTarget({ kind: 'local' })).toBe('local');
    expect(formatTarget({ kind: 'ssh', alias: 'a' })).toBe('ssh:a');
    expect(escapeXmlAttr(`we"ird<&>'`)).toBe('we&quot;ird&lt;&amp;&gt;&apos;');
  });
});
