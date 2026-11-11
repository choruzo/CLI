// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Inspection } from '../../client/code-actions';
import type { NativeBridge } from '../../ipc/native';
import { matchCommands, parseCommand } from '../chat/commands';
import { SetupPanel, environmentRules, groupTools, profileTools } from './SetupPanel';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), Channel: class {} }));

afterEach(cleanup);

const inspection = (over: Partial<Inspection> = {}): Inspection => ({
  profile: {
    requested: 'auto',
    active: 'code',
    detection: { detected: false, reasons: [] },
    available: [
      { name: 'code', description: 'desarrollo', allowedTools: null, hiddenTools: ['ssh_exec'], source: 'builtin' },
      { name: 'infra', description: 'infraestructura', allowedTools: null, hiddenTools: [], source: 'builtin' },
      { name: 'docs', description: 'solo leer', allowedTools: ['read_file', 'grep'], hiddenTools: [], source: 'config' },
    ],
  },
  tools: [
    { name: 'read_file', source: 'builtin' },
    { name: 'exec', source: 'builtin' },
    { name: 'mcp__docs__search', source: 'mcp' },
    { name: 'mcp__docs__fetch', source: 'mcp' },
  ],
  mcp: [{ name: 'docs', status: 'connected', tools: 2 }],
  plugins: {
    enabled: true,
    loaded: [{ id: 'guard', source: 'global', hooks: { 'tool.before': 1 } }],
    skipped: [{ id: 'roto', reason: 'no se pudo cargar' }],
  },
  environments: [
    {
      name: 'prod',
      tier: 'production',
      policy: 'confirm-always',
      requirePlan: true,
      readOnly: false,
      confirmation: 'typed',
      match: ['ssh:prod-*'],
    },
  ],
  truncated: false,
  ...over,
});

function panel(
  inspectSession: NativeBridge['inspectSession'],
  over: Partial<Parameters<typeof SetupPanel>[0]> = {},
) {
  const onProfile = vi.fn();
  const view = render(
    <SetupPanel
      native={{ inspectSession } as unknown as NativeBridge}
      sessionId="ses_1"
      refreshKey="a"
      connected
      locked={null}
      activeTarget="ssh:prod-1"
      activeEnvironment="prod"
      onProfile={onProfile}
      {...over}
    />,
  );
  return { onProfile, ...view };
}

describe('textos puros del montaje', () => {
  it('las reglas de un entorno, como /env', () => {
    const [prod] = inspection().environments;
    expect(environmentRules(prod!)).toBe(
      'los cambios piden un plan aprobado; cada cambio pide teclear el alias del destino',
    );
    expect(environmentRules({ ...prod!, readOnly: true })).toBe('solo lectura: cualquier cambio se rechaza');
    expect(
      environmentRules({ ...prod!, policy: 'ask', requirePlan: false, confirmation: 'simple' }),
    ).toBe('confirmaciones normales');
    expect(environmentRules({ ...prod!, policy: 'allow', requirePlan: false })).toBe(
      'los cambios se ejecutan sin confirmación',
    );
  });

  it('las tools de un perfil y el agrupado por server MCP', () => {
    const [code, infra, docs] = inspection().profile!.available;
    expect(profileTools(code!)).toBe('todas salvo ssh_exec');
    expect(profileTools(infra!)).toBe('todas');
    expect(profileTools(docs!)).toBe('read_file, grep');
    expect(groupTools(inspection().tools)).toEqual({
      builtin: ['read_file', 'exec'],
      mcp: [['docs', ['search', 'fetch']]],
    });
  });
});

describe('SetupPanel', () => {
  it('enseña perfil, tools, MCP, entornos y plugins de la sesión', async () => {
    const inspect = vi.fn(async () => ({ inspection: inspection() }));
    panel(inspect);
    const profiles = await screen.findByRole('radiogroup', { name: 'Perfil de sesión' });
    expect(inspect).toHaveBeenCalledWith('ses_1');
    expect(within(profiles).getByRole('radio', { name: /^code/ }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText(/sin infraestructura a la vista/)).toBeTruthy();
    expect(screen.getByText('Tools · 4')).toBeTruthy();
    expect(screen.getByText('MCP · docs')).toBeTruthy();
    expect(screen.getByText(/connected · 2 tools/)).toBeTruthy();
    expect(screen.getByText('producción')).toBeTruthy();
    expect(screen.getByText(/→ prod/)).toBeTruthy();
    expect(screen.getByText('tool.before ×1')).toBeTruthy();
    expect(screen.getByText('roto · omitido')).toBeTruthy();
  });

  it('elegir otro perfil lo pide; el activo y una sesión bloqueada no', async () => {
    const inspect = vi.fn(async () => ({ inspection: inspection() }));
    const { onProfile, unmount } = panel(inspect);
    const infra = await screen.findByRole('radio', { name: /^infra/ });
    fireEvent.click(screen.getByRole('radio', { name: /^code/ }));
    expect(onProfile).not.toHaveBeenCalled();
    fireEvent.click(infra);
    expect(onProfile).toHaveBeenCalledWith('infra');
    // Sin estado optimista: sigue marcado el que dice el daemon.
    expect(infra.getAttribute('aria-checked')).toBe('false');
    unmount();

    const locked = panel(inspect, { locked: 'Se podrá cambiar cuando acabe el turno en marcha.' });
    const blocked = await screen.findByRole('radio', { name: /^infra/ });
    expect((blocked as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(blocked);
    expect(locked.onProfile).not.toHaveBeenCalled();
    expect(screen.getByText('Se podrá cambiar cuando acabe el turno en marcha.')).toBeTruthy();
  });

  it('se relee al cambiar la clave y descarta lo de otra sesión', async () => {
    const inspect = vi.fn(async () => ({ inspection: inspection() }));
    const { rerender } = panel(inspect);
    await screen.findByText('Tools · 4');
    const props = {
      native: { inspectSession: inspect } as unknown as NativeBridge,
      connected: true,
      locked: null,
      activeTarget: null,
      activeEnvironment: null,
      onProfile: vi.fn(),
    };
    rerender(<SetupPanel {...props} sessionId="ses_1" refreshKey="b" />);
    await waitFor(() => expect(inspect).toHaveBeenCalledTimes(2));
    rerender(<SetupPanel {...props} sessionId={null} refreshKey="" />);
    expect(screen.getByText(/Abre una sesión de código/)).toBeTruthy();
    expect(screen.queryByText('Tools · 4')).toBeNull();
  });

  it('una sesión sin montar o de una terminal lo dice; un agente embebido no tiene perfil', async () => {
    const rejected = (reason: string) =>
      vi.fn(async () => {
        throw { kind: 'rejected', code: 'UNAVAILABLE', message: 'x', reason };
      });
    const first = panel(rejected('not-loaded'));
    expect(await screen.findByText(/aún no se ha montado/)).toBeTruthy();
    first.unmount();
    const second = panel(rejected('peer-hosted'));
    expect(await screen.findByText(/la aloja una terminal/)).toBeTruthy();
    second.unmount();
    panel(vi.fn(async () => ({ inspection: inspection({ profile: null }) })));
    await screen.findByText('Tools · 4');
    expect(screen.queryByRole('radiogroup')).toBeNull();
  });

  it('una respuesta que no es del contrato no se pinta', async () => {
    panel(vi.fn(async () => ({ inspection: { tools: 'muchas' } })));
    expect(await screen.findByText(/no se entiende/)).toBeTruthy();
  });
});

describe('comandos del montaje', () => {
  it('/profile, /tools, /env y /plugins son del modo código', () => {
    expect(matchCommands('/pro', 'code')?.map((c) => c.name)).toEqual(['profile']);
    expect(matchCommands('/pro', 'chat')).toEqual([]);
    expect(parseCommand('/profile infra', 'code')).toEqual({ ok: true, name: 'profile', arg: 'infra' });
    expect(parseCommand('/profile', 'code')).toEqual({ ok: true, name: 'profile', arg: '' });
    for (const name of ['tools', 'env', 'plugins'] as const) {
      expect(parseCommand(`/${name}`, 'code')).toEqual({ ok: true, name, arg: '' });
      expect(parseCommand(`/${name} x`, 'code')).toMatchObject({ ok: false });
      expect(parseCommand(`/${name}`, 'chat')).toMatchObject({ ok: false });
    }
  });
});
