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
    for (const raw of ['pod:ctx/ns/name', 'winrm:dc1']) {
      const r = parseTarget(raw);
      expect(r.ok).toBe(false);
      expect(!r.ok && r.error).toContain('not available yet');
      expect(!r.ok && r.error).toContain('ssh:<alias>');
      expect(!r.ok && r.error).toContain('container:<box>');
    }
  });

  it('container:<caja> (M13); sin nombre es un error', () => {
    expect(parseTarget('container:box')).toEqual({
      ok: true,
      target: { kind: 'container', name: 'box' },
    });
    expect(parseTarget('container:').ok).toBe(false);
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

  it('container: solo la caja configurada y con opt-in (box.enabled)', () => {
    const off = StratumConfigSchema.parse({});
    const r = resolveTarget({ kind: 'container', name: 'box' }, off);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain('box.enabled');

    const on = StratumConfigSchema.parse({ box: { enabled: true, name: 'lab' } });
    expect(resolveTarget({ kind: 'container', name: 'lab' }, on)).toEqual({ ok: true });
    // Otro nombre no alcanza ningún otro contenedor del usuario.
    const other = resolveTarget({ kind: 'container', name: 'postgres' }, on);
    expect(other.ok).toBe(false);
    expect(!other.ok && other.error).toContain('container:lab');
  });
});

describe('formatTarget / escapeXmlAttr', () => {
  it('formatea y escapa', () => {
    expect(formatTarget({ kind: 'local' })).toBe('local');
    expect(formatTarget({ kind: 'ssh', alias: 'a' })).toBe('ssh:a');
    expect(formatTarget({ kind: 'container', name: 'box' })).toBe('container:box');
    expect(escapeXmlAttr(`we"ird<&>'`)).toBe('we&quot;ird&lt;&amp;&gt;&apos;');
  });
});
