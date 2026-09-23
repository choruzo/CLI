import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { StratumConfigSchema, type StratumConfig } from '../config/schema.js';
import {
  callEffects,
  matchesTarget,
  resolveEnvironment,
  listEnvironments,
  targetOfCall,
  describeEnvironmentRules,
} from './environments.js';
import { environmentGate, readOnlyVeto, requirePlanViolation } from './call-policy.js';
import { ToolRegistry, ToolDispatcher } from './registry.js';
import type {
  ConfirmRequest,
  DestructiveDecision,
  ToolContext,
  ToolDefinition,
} from '../agent/types.js';

function cfg(extra: Record<string, unknown> = {}): StratumConfig {
  return StratumConfigSchema.parse({
    environments: {
      prod: { match: ['ssh:prod-*'], tier: 'production', requirePlan: true },
      staging: { match: ['ssh:stg-*'], tier: 'staging' },
      lab: { match: ['ssh:lab-*', 'local'], policy: 'allow' },
      audit: { match: ['ssh:audit-*'], readOnly: true },
    },
    ...extra,
  });
}

describe('entornos — resolución (Hito 17)', () => {
  it('los globs casan sin distinguir mayúsculas y anclados', () => {
    expect(matchesTarget('ssh:prod-*', 'ssh:prod-db')).toBe(true);
    expect(matchesTarget('ssh:prod-*', 'SSH:Prod-DB')).toBe(true);
    expect(matchesTarget('ssh:prod-*', 'ssh:preprod-db')).toBe(false);
    expect(matchesTarget('ssh:db-?', 'ssh:db-1')).toBe(true);
    expect(matchesTarget('ssh:db-?', 'ssh:db-10')).toBe(false);
    expect(matchesTarget('local', 'local')).toBe(true);
  });

  it('los defaults salen del tier: production → confirm-always + typed', () => {
    const [prod, staging, lab] = listEnvironments(cfg());
    expect(prod).toMatchObject({
      tier: 'production',
      policy: 'confirm-always',
      confirmation: 'typed',
    });
    expect(staging).toMatchObject({ tier: 'staging', policy: 'ask', confirmation: 'simple' });
    expect(lab).toMatchObject({ tier: 'development', policy: 'allow', confirmation: 'simple' });
  });

  it('con varios entornos candidatos gana el de tier más alto', () => {
    const config = StratumConfigSchema.parse({
      environments: {
        everything: { match: ['*'], policy: 'allow' },
        prod: { match: ['ssh:prod-*'], tier: 'production' },
      },
    });
    expect(resolveEnvironment('ssh:prod-db', config)?.name).toBe('prod');
    expect(resolveEnvironment('ssh:dev-1', config)?.name).toBe('everything');
    expect(resolveEnvironment('ssh:x', StratumConfigSchema.parse({}))).toBeNull();
  });

  it('el schema rechaza nombres de entorno inválidos y listas vacías', () => {
    expect(() =>
      StratumConfigSchema.parse({ environments: { 'mal nombre': { match: ['x'] } } }),
    ).toThrow();
    expect(() => StratumConfigSchema.parse({ environments: { prod: { match: [] } } })).toThrow();
  });

  it('describeEnvironmentRules resume las reglas', () => {
    const [prod, , , audit] = listEnvironments(cfg());
    expect(describeEnvironmentRules(prod!)).toContain('approved plan');
    expect(describeEnvironmentRules(prod!)).toContain('type the target alias');
    expect(describeEnvironmentRules(audit!)).toContain('read-only');
  });
});

describe('efectos de una tool call (Hito 17)', () => {
  it('exec es mutante o no según su comando, sobre su target', () => {
    expect(callEffects('exec', { command: 'ls', target: 'ssh:prod-db' })).toMatchObject({
      mutating: false,
      targets: [{ target: 'ssh:prod-db', mutating: false }],
    });
    expect(callEffects('exec', { command: 'rm x', target: 'ssh:prod-db' })).toMatchObject({
      mutating: true,
      targets: [{ target: 'ssh:prod-db', mutating: true }],
    });
  });

  it('ssh_upload muta el remoto; ssh_download muta el local', () => {
    expect(callEffects('ssh_upload', { host: 'prod-db' }).targets).toEqual([
      { target: 'ssh:prod-db', mutating: true },
      { target: 'local', mutating: false },
    ]);
    expect(callEffects('ssh_download', { host: 'prod-db' }).targets).toEqual([
      { target: 'ssh:prod-db', mutating: false },
      { target: 'local', mutating: true },
    ]);
  });

  it('las tools desconocidas (MCP) cuentan como mutantes', () => {
    expect(callEffects('mcp__k8s__apply', {})).toMatchObject({ known: false, mutating: true });
    expect(callEffects('read_file', { path: 'x' }).mutating).toBe(false);
    expect(callEffects('web_fetch', { url: 'x' })).toMatchObject({ mutating: false, targets: [] });
    expect(callEffects('store_decision', {}).mutating).toBe(true);
  });

  it('targetOfCall lee el target de los argumentos crudos', () => {
    expect(targetOfCall('exec', '{"command":"ls","target":"ssh:db"}')).toBe('ssh:db');
    expect(targetOfCall('exec', '{"command":"ls"}')).toBe('local');
    expect(targetOfCall('ssh_upload', '{"host":"db"}')).toBe('ssh:db');
    expect(targetOfCall('read_file', '{"path":"x"}')).toBeNull();
    expect(targetOfCall('exec', '{"command":')).toBeNull();
  });
});

describe('políticas por llamada (Hito 17)', () => {
  const config = cfg();

  it('sesión read-only: veta lo que muta, deja pasar lo que observa', () => {
    const ctx = { readOnly: true, config };
    expect(readOnlyVeto('exec', { command: 'ls -la' }, ctx)).toBeNull();
    const veto = readOnlyVeto('write_file', { path: 'a', content: 'b' }, ctx);
    expect(veto).toMatchObject({ ok: false, recoverable: true, countsAsFailure: false });
    expect(readOnlyVeto('exec', { command: 'touch x' }, ctx)).not.toBeNull();
    expect(readOnlyVeto('mcp__x__y', {}, ctx)).not.toBeNull();
  });

  it('entorno read-only: veta cambios solo en sus targets', () => {
    const ctx = { config };
    expect(readOnlyVeto('exec', { command: 'rm x', target: 'ssh:audit-1' }, ctx)).not.toBeNull();
    expect(readOnlyVeto('exec', { command: 'cat x', target: 'ssh:audit-1' }, ctx)).toBeNull();
    expect(readOnlyVeto('exec', { command: 'rm x', target: 'ssh:stg-1' }, ctx)).toBeNull();
  });

  it('el workspace de Desktop queda fuera de los entornos', () => {
    const workspace = { root: '/tmp/ws' };
    const config2 = StratumConfigSchema.parse({
      environments: { ro: { match: ['local'], readOnly: true, requirePlan: true } },
    });
    expect(readOnlyVeto('write_file', { path: 'a' }, { config: config2, workspace })).toBeNull();
    expect(requirePlanViolation('write_file', { path: 'a' }, config2, workspace)).toBeNull();
    expect(requirePlanViolation('write_file', { path: 'a' }, config2)?.env.name).toBe('ro');
  });

  it('requirePlan solo afecta a lo que muta', () => {
    expect(
      requirePlanViolation('exec', { command: 'df -h', target: 'ssh:prod-1' }, config),
    ).toBeNull();
    expect(
      requirePlanViolation(
        'exec',
        { command: 'systemctl restart x', target: 'ssh:prod-1' },
        config,
      ),
    ).toMatchObject({ target: 'ssh:prod-1' });
  });

  it('environmentGate: confirm-always forzado con frase = alias', () => {
    const gate = environmentGate('exec', { command: 'rm x', target: 'ssh:prod-db' }, { config });
    expect(gate).toMatchObject({ forced: true, phrase: 'prod-db', target: 'ssh:prod-db' });
    expect(
      environmentGate('exec', { command: 'ls', target: 'ssh:prod-db' }, { config }),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Dispatcher con una `exec` falsa: las reglas dependen del nombre y los
// argumentos, no de ejecutar nada de verdad.
// ---------------------------------------------------------------------------

function fakeExec(run = vi.fn(async () => ({ ok: true as const, output: 'ran' }))) {
  const tool: ToolDefinition = {
    name: 'exec',
    description: 'fake',
    schema: z.object({ command: z.string(), target: z.string().optional() }),
    isDestructive: (p) => /\brm\b/.test((p as { command: string }).command),
    execute: run,
  };
  const registry = new ToolRegistry();
  registry.register(tool);
  return { registry, run };
}

function ctxWith(config: StratumConfig, overrides: Partial<ToolContext> = {}): ToolContext {
  return { signal: new AbortController().signal, cwd: process.cwd(), config, ...overrides };
}

const call = (command: string, target?: string, id = 'c1') => ({
  id,
  name: 'exec',
  input: target ? { command, target } : { command },
});

describe('ToolDispatcher con entornos y read-only (Hito 17)', () => {
  it('read-only de sesión: ni --allow-destructive ni allow-all lo levantan', async () => {
    const { registry, run } = fakeExec();
    const d = new ToolDispatcher(registry);
    const [res] = await d.dispatch(
      [call('touch x')],
      ctxWith(cfg(), { readOnly: true, destructivePolicy: 'allow' }),
    );
    expect(res!.result).toMatchObject({ ok: false, countsAsFailure: false });
    expect(run).not.toHaveBeenCalled();
    // …y una lectura pasa sin preguntar.
    const [ok] = await d.dispatch([call('ls')], ctxWith(cfg(), { readOnly: true }));
    expect(ok!.result.ok).toBe(true);
  });

  it('confirm-always pregunta con frase aunque la política sea allow y confirmDestructive esté off', async () => {
    const { registry, run } = fakeExec();
    const config = cfg({ tools: { confirmDestructive: false } });
    const seen: ConfirmRequest[] = [];
    const d = new ToolDispatcher(registry);
    const [res] = await d.dispatch([call('touch /srv/flag', 'ssh:prod-db')], {
      ...ctxWith(config, { destructivePolicy: 'allow' }),
      confirmDestructive: async (req) => {
        seen.push(req);
        return 'approve';
      },
    });
    expect(res!.result.ok).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
    expect(seen[0]).toMatchObject({
      confirmPhrase: 'prod-db',
      forced: true,
      environment: { name: 'prod', tier: 'production' },
    });
  });

  it('un allow-all sobre confirm-always vale solo para esa llamada', async () => {
    const { registry, run } = fakeExec();
    const confirm = vi.fn(async (): Promise<DestructiveDecision> => 'allow-all');
    const d = new ToolDispatcher(registry);
    const ctx = { ...ctxWith(cfg()), confirmDestructive: confirm };
    await d.dispatch([call('touch a', 'ssh:prod-db')], ctx);
    await d.dispatch([call('touch b', 'ssh:prod-db')], ctx);
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('confirm-always sin nadie que confirme (CI) se bloquea', async () => {
    const { registry, run } = fakeExec();
    const d = new ToolDispatcher(registry);
    const [res] = await d.dispatch(
      [call('touch x', 'ssh:prod-db')],
      ctxWith(cfg(), { destructivePolicy: 'allow' }),
    );
    expect(res!.result).toMatchObject({ ok: false, recoverable: true });
    expect(!res!.result.ok && res!.result.error).toContain('Environment "prod"');
    expect(run).not.toHaveBeenCalled();
  });

  it('leer en producción no pregunta nada', async () => {
    const { registry, run } = fakeExec();
    const confirm = vi.fn(async (): Promise<DestructiveDecision> => 'deny');
    const d = new ToolDispatcher(registry);
    const [res] = await d.dispatch([call('journalctl -u api', 'ssh:prod-db')], {
      ...ctxWith(cfg()),
      confirmDestructive: confirm,
    });
    expect(res!.result.ok).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('entorno allow: un rm no pregunta, salvo con --deny-destructive o confirmAll del host', async () => {
    const { registry, run } = fakeExec();
    const confirm = vi.fn(async (): Promise<DestructiveDecision> => 'deny');
    const d = new ToolDispatcher(registry);
    const [ok] = await d.dispatch([call('rm x', 'ssh:lab-1')], {
      ...ctxWith(cfg()),
      confirmDestructive: confirm,
    });
    expect(ok!.result.ok).toBe(true);
    expect(confirm).not.toHaveBeenCalled();

    const [denied] = await d.dispatch(
      [call('rm x', 'ssh:lab-1')],
      ctxWith(cfg(), { destructivePolicy: 'deny' }),
    );
    expect(denied!.result.ok).toBe(false);

    const withConfirmAll = cfg({
      ssh: {
        hosts: { 'lab-1': { host: '10.0.0.1', user: 'u', password: 'x', confirmAll: true } },
      },
    });
    await d.dispatch([call('rm y', 'ssh:lab-1')], {
      ...ctxWith(withConfirmAll),
      confirmDestructive: confirm,
    });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('entorno read-only: rechazo inapelable antes de confirmar', async () => {
    const { registry, run } = fakeExec();
    const confirm = vi.fn(async (): Promise<DestructiveDecision> => 'approve');
    const d = new ToolDispatcher(registry);
    const [res] = await d.dispatch([call('rm x', 'ssh:audit-7')], {
      ...ctxWith(cfg(), { destructivePolicy: 'allow' }),
      confirmDestructive: confirm,
    });
    expect(res!.result.ok).toBe(false);
    expect(confirm).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });
});
