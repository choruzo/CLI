import { describe, it, expect, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { delimiter, join } from 'path';
import { StratumConfigSchema, type StratumConfig } from '../config/schema.js';
import {
  detectInfrastructure,
  listSessionProfiles,
  profileAllows,
  resolveSessionProfile,
  sessionProfileFilter,
} from './session-profile.js';
import { StratumAgent } from './core.js';
import { ProfileLoader } from './profiles.js';
import { ToolRegistry, composeToolsetFilters, isToolVisibleForProfile } from '../tools/registry.js';
import { registerBuiltinTools } from '../tools/index.js';
import { MockProvider, makeTextRound, makeToolCallRound } from '../providers/mock.js';
import type { ProviderRouter } from '../providers/router.js';
import type { IProvider } from '../providers/base.js';
import type { AgentEvent } from './types.js';
import { sessionProfileFlag } from '../cli/session-flags.js';
import { formatEnvironmentsReport, formatSessionProfileReport } from '../cli/session-report.js';
import { formatEnvironmentBadge } from '../cli/ui/StatusBar.js';
import { typedPhraseMatches } from '../cli/ui/DestructiveConfirm.js';

const tmp = mkdtempSync(join(tmpdir(), 'stratum-h17-profile-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const base = StratumConfigSchema.parse({});
const none = () => ({ detected: false, reasons: [] });
const some = () => ({ detected: true, reasons: ['kubectl in PATH'] });

describe('perfil de sesión (Hito 17, §10.5)', () => {
  it('auto: full con infraestructura a la vista, code sin ella', () => {
    const withInfra = resolveSessionProfile('auto', base, some);
    const without = resolveSessionProfile(undefined, base, none);
    expect(withInfra.ok && withInfra.profile.name).toBe('full');
    expect(withInfra.ok && withInfra.auto?.reasons).toEqual(['kubectl in PATH']);
    expect(without.ok && without.profile.name).toBe('code');
  });

  it('un nombre desconocido es un error que lista los disponibles', () => {
    const r = resolveSessionProfile('ops', base, none);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain('auto, code, infra, full');
  });

  it('code oculta las tools de infraestructura; infra oculta las de código', () => {
    const code = listSessionProfiles(base).find((p) => p.name === 'code')!;
    const infra = listSessionProfiles(base).find((p) => p.name === 'infra')!;
    expect(profileAllows(code, 'ssh_upload')).toBe(false);
    expect(profileAllows(code, 'write_file')).toBe(true);
    expect(profileAllows(infra, 'write_file')).toBe(false);
    expect(profileAllows(infra, 'exec')).toBe(true);
    expect(profileAllows(infra, 'mcp__k8s__get_pods')).toBe(true);
    // las de control pasan, salvo test_evidence
    expect(profileAllows(infra, 'present_plan')).toBe(true);
    expect(profileAllows(infra, 'test_evidence')).toBe(false);
  });

  it('la config sobrescribe un integrado y añade perfiles propios', () => {
    const config = StratumConfigSchema.parse({
      session: {
        profiles: {
          infra: { allowedTools: ['exec', 'read_file'] },
          ops: { description: 'guardias', hiddenTools: ['write_file'] },
        },
      },
    });
    const infra = listSessionProfiles(config).find((p) => p.name === 'infra')!;
    expect(infra.source).toBe('config');
    expect(profileAllows(infra, 'grep')).toBe(false);
    const ops = resolveSessionProfile('ops', config, none);
    expect(ops.ok && profileAllows(ops.profile, 'write_file')).toBe(false);
    expect(() =>
      StratumConfigSchema.parse({ session: { profiles: { auto: { allowedTools: [] } } } }),
    ).toThrow();
  });

  it('detectInfrastructure: inventario ssh o un binario en el PATH', () => {
    const bin = join(tmp, 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'kubectl'), '');
    const found = detectInfrastructure(base, { PATH: [bin, tmp].join(delimiter) }, 'linux');
    expect(found).toEqual({ detected: true, reasons: ['kubectl in PATH'] });
    expect(detectInfrastructure(base, { PATH: tmp }, 'linux').detected).toBe(false);

    const withHosts = StratumConfigSchema.parse({
      ssh: { hosts: { db: { host: '10.0.0.1', user: 'u', password: 'x' } } },
    });
    expect(detectInfrastructure(withHosts, { PATH: '' }, 'linux').reasons).toEqual([
      'ssh inventory (1 host)',
    ]);
  });

  it('composeToolsetFilters intersecta perfil de sesión y de agente', () => {
    const infra = listSessionProfiles(base).find((p) => p.name === 'infra')!;
    const filter = composeToolsetFilters(sessionProfileFilter(infra), {
      allowedTools: ['exec', 'write_file'],
      controlTools: 'keep',
    });
    expect(isToolVisibleForProfile('exec', filter)).toBe(true);
    expect(isToolVisibleForProfile('write_file', filter)).toBe(false); // lo oculta la sesión
    expect(isToolVisibleForProfile('grep', filter)).toBe(false); // lo oculta el agente
    expect(isToolVisibleForProfile('todo', filter)).toBe(true);
    expect(composeToolsetFilters(undefined, undefined)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// StratumAgent
// ---------------------------------------------------------------------------

function fakeRouter(provider: IProvider): ProviderRouter {
  return {
    getActive: () => provider,
    model: 'mock',
    providerName: 'mock',
    contextWindow: 32768,
    hasFallback: false,
    advanceProvider: () => null,
    resetFallback: () => undefined,
  } as unknown as ProviderRouter;
}

function newAgent(config: StratumConfig, provider: IProvider, extra = {}) {
  const registry = new ToolRegistry();
  registerBuiltinTools(registry, config);
  return new StratumAgent(config, fakeRouter(provider), registry, {
    profileLoader: new ProfileLoader(tmp),
    ...extra,
  });
}

const system = (agent: StratumAgent) => agent.getMessages()[0]?.content ?? '';

describe('StratumAgent — read-only, perfil y contexto activo (Hito 17)', () => {
  it('read-only entra en el system prompt y se alterna con setReadOnly', () => {
    const agent = newAgent(base, new MockProvider([]), { readOnly: true, sessionProfile: 'code' });
    expect(system(agent)).toContain('# Read-only mode');
    agent.setReadOnly(false);
    expect(agent.isReadOnly()).toBe(false);
    expect(system(agent)).not.toContain('# Read-only mode');
  });

  it('el perfil infra no enseña el ciclo TDD aunque haya testCommand', () => {
    const config = StratumConfigSchema.parse({ tools: { testCommand: 'npm test' } });
    const agent = newAgent(config, new MockProvider([]), { sessionProfile: 'code' });
    expect(system(agent)).toContain('# Testing discipline');
    const applied = agent.setSessionProfile('infra');
    expect(applied.ok).toBe(true);
    expect(system(agent)).not.toContain('# Testing discipline');
    expect(agent.setSessionProfile('nope').ok).toBe(false);
  });

  it('un perfil pedido inexistente cae a auto con aviso', () => {
    const agent = newAgent(base, new MockProvider([]), { sessionProfile: 'nope' });
    expect(agent.getSessionProfileRequest()).toBe('auto');
    expect(agent.takeResumeNotice()).toContain('no existe');
  });

  it('el bloque de entornos llega al prompt cuando hay entornos', () => {
    const config = StratumConfigSchema.parse({
      environments: { prod: { match: ['ssh:prod-*'], tier: 'production' } },
    });
    expect(system(newAgent(config, new MockProvider([])))).toContain('# Environments');
    expect(system(newAgent(base, new MockProvider([])))).not.toContain('# Environments');
  });

  it('el contexto activo sigue al último target donde algo se ejecutó', async () => {
    const config = StratumConfigSchema.parse({
      environments: { local: { match: ['local'], tier: 'staging' } },
    });
    const provider = new MockProvider([
      makeToolCallRound('c1', 'exec', { command: 'echo hola' }),
      makeTextRound('ok'),
    ]);
    const agent = newAgent(config, provider, { sessionProfile: 'code' });
    expect(agent.getActiveContext().target).toBe('local');
    const events: AgentEvent[] = [];
    for await (const ev of agent.run('di hola', { destructivePolicy: 'allow' })) events.push(ev);
    expect(events.some((e) => e.type === 'tool_result')).toBe(true);
    expect(agent.getActiveContext()).toMatchObject({
      target: 'local',
      environment: { name: 'local', tier: 'staging' },
    });
  });

  it('la sesión read-only viaja al turno aunque las opciones no lo pidan', async () => {
    const provider = new MockProvider([
      makeToolCallRound('c1', 'write_file', { path: join(tmp, 'x.txt'), content: 'y' }),
      makeTextRound('ok'),
    ]);
    const agent = newAgent(base, provider, { readOnly: true, sessionProfile: 'code' });
    const events: AgentEvent[] = [];
    for await (const ev of agent.run('escribe', {})) events.push(ev);
    const err = events.find((e) => e.type === 'tool_error') as { error: string } | undefined;
    expect(err?.error).toContain('read-only');
  });
});

describe('piezas de la CLI (Hito 17)', () => {
  it('sessionProfileFlag: atajos y conflicto', () => {
    expect(sessionProfileFlag({ infra: true })).toEqual({ ok: true, profile: 'infra' });
    expect(sessionProfileFlag({ code: true })).toEqual({ ok: true, profile: 'code' });
    expect(sessionProfileFlag({ profile: 'ops' })).toEqual({ ok: true, profile: 'ops' });
    expect(sessionProfileFlag({})).toEqual({ ok: true, profile: undefined });
    expect(sessionProfileFlag({ infra: true, code: true }).ok).toBe(false);
  });

  it('informes de /profile y /env', () => {
    const profiles = listSessionProfiles(base);
    const report = formatSessionProfileReport(
      profiles.find((p) => p.name === 'full')!,
      'auto',
      { detected: true, reasons: ['docker in PATH'] },
      profiles,
    );
    expect(report).toContain('Perfil de sesión: full (auto: docker in PATH)');
    expect(report).toContain('◆ full');

    const config = StratumConfigSchema.parse({
      environments: { prod: { match: ['ssh:prod-*'], tier: 'production' } },
    });
    const env = formatEnvironmentsReport(
      [
        {
          name: 'prod',
          tier: 'production',
          policy: 'confirm-always',
          requirePlan: false,
          readOnly: false,
          confirmation: 'typed',
          match: ['ssh:prod-*'],
        },
      ],
      { target: 'ssh:prod-db', environment: null },
    );
    expect(env).toContain('Contexto activo: ssh:prod-db (sin entorno)');
    expect(env).toContain('prod (production)');
    expect(formatEnvironmentsReport([], { target: 'local', environment: null })).toContain(
      'No hay entornos',
    );
    expect(config.environments?.prod?.match).toEqual(['ssh:prod-*']);
  });

  it('badge de entorno y frase tecleada', () => {
    const env = { name: 'prod', tier: 'production' as const, target: 'ssh:db' };
    expect(formatEnvironmentBadge(env, true)).toBe('⬢ prod ssh:db');
    expect(formatEnvironmentBadge(env, false)).toBe('⬢ prod');
    expect(formatEnvironmentBadge(null, true)).toBe('');
    expect(typedPhraseMatches(' prod-db ', 'prod-db')).toBe(true);
    expect(typedPhraseMatches('prod', 'prod-db')).toBe(false);
    expect(typedPhraseMatches('PROD-DB', 'prod-db')).toBe(false);
  });
});
