import { describe, it, expect } from 'vitest';
import { createExecTool, describeExecTool } from './exec.js';
import { StratumConfigSchema } from '../../config/schema.js';
import type { ToolContext } from '../../agent/types.js';

const config = StratumConfigSchema.parse({
  tools: { auditLog: false },
  ssh: {
    hosts: {
      bastion: { host: 'b', user: 'u', password: 'p' },
      prod: { host: 'p', user: 'u', password: 'p', jumpHost: 'bastion', confirmAll: true },
    },
  },
});
const tool = createExecTool(config);

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return { signal: new AbortController().signal, cwd: process.cwd(), config, ...overrides };
}

describe('exec — descripción generada (Hito 16)', () => {
  it('lista local y cada alias con sus flags', () => {
    const text = describeExecTool(config);
    expect(text).toContain('- local');
    expect(text).toContain('- ssh:bastion');
    expect(text).toContain('- ssh:prod (via bastion; confirmAll');
    expect(tool.description).toBe(text);
  });

  it('sin inventario solo ofrece local', () => {
    const text = describeExecTool(StratumConfigSchema.parse({}));
    expect(text).not.toContain('ssh:');
  });
});

describe('exec — preflight', () => {
  it('valida el target antes que el veto: el error es recuperable', () => {
    const r = tool.preflight!({ target: 'pod:ctx/ns/x', command: 'rm -rf /' }, ctx());
    expect(r).toMatchObject({ ok: false, recoverable: true });
    expect(r && !r.ok && r.error).toContain('not available yet');
  });

  it('un alias desconocido lista los disponibles', () => {
    const r = tool.preflight!({ target: 'ssh:nope', command: 'uptime' }, ctx());
    expect(r).toMatchObject({ ok: false, recoverable: true });
    expect(r && !r.ok && r.error).toContain('bastion');
  });

  it('pty + stdin se rechaza', () => {
    const r = tool.preflight!({ target: 'ssh:prod', command: 'x', pty: true, stdin: 'y' }, ctx());
    expect(r).toMatchObject({ ok: false, recoverable: true });
  });

  it('el veto de las guardas vale en todos los targets y lleva el target delante', () => {
    for (const target of [undefined, 'ssh:prod']) {
      const r = tool.preflight!({ target, command: 'rm -rf /' }, ctx());
      expect(r).toMatchObject({ ok: false, recoverable: false });
      expect(r && !r.ok && r.error).toMatch(/^\[(local|ssh:prod)\] Blocked/);
    }
  });

  it('un comando corriente pasa', () => {
    expect(tool.preflight!({ command: 'git status' }, ctx())).toBeNull();
  });
});

describe('exec — isDestructive e isSerialized', () => {
  it('confirmAll del host confirma cualquier comando remoto', () => {
    expect(tool.isDestructive!({ target: 'ssh:prod', command: 'ls' }, ctx())).toBe(true);
    expect(tool.isDestructive!({ target: 'ssh:bastion', command: 'ls' }, ctx())).toBe(false);
    expect(tool.isDestructive!({ command: 'rm -rf build' }, ctx())).toBe(true);
  });

  it('local serializa, ssh no, y un input inválido serializa', () => {
    expect(tool.isSerialized!({ command: 'ls' }, ctx())).toBe(true);
    expect(tool.isSerialized!({ target: 'ssh:prod', command: 'ls' }, ctx())).toBe(false);
    expect(tool.isSerialized!({ nope: 1 }, ctx())).toBe(true);
    expect(tool.isSerialized!({ target: 'bogus:x', command: 'ls' }, ctx())).toBe(true);
  });
});
