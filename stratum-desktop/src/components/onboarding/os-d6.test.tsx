import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import { TurnWatch, formatElapsed, notificationText } from '../../hooks/turn-notifications';
import { configApplied, osPrefs } from '../../ipc/validate';
import { initialConfigState, type Config } from '../../hooks/useConfig';
import { HotkeySetting, type FieldContext } from '../settings/fields';
import { Onboarding } from './Onboarding';
import { StartupFailure } from './StartupFailure';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), Channel: class {} }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));

afterEach(() => {
  cleanup();
  vi.mocked(invoke).mockReset();
});

describe('TurnWatch (D6)', () => {
  const c = 'conv-1';

  it('notifica una respuesta que tarda al menos minSeconds, contando la cola', () => {
    const w = new TurnWatch();
    expect(w.onFrame({ type: 'turn_queued', conversationId: c, turnId: 't1' }, 0, 10)).toBeNull();
    expect(w.onFrame({ type: 'turn_started', conversationId: c, turnId: 't1' }, 8_000, 10)).toBeNull();
    expect(w.onFrame({ type: 'turn_ended', conversationId: c, turnId: 't1', stopReason: 'stop' }, 12_000, 10)).toEqual({
      kind: 'turn',
      conversationId: c,
      elapsedMs: 12_000,
      stopReason: 'stop',
    });
  });

  it('no notifica respuestas cortas, canceladas ni turnos que no vio empezar', () => {
    const w = new TurnWatch();
    w.onFrame({ type: 'turn_started', conversationId: c, turnId: 'a' }, 0, 10);
    expect(w.onFrame({ type: 'turn_ended', conversationId: c, turnId: 'a', stopReason: 'stop' }, 9_999, 10)).toBeNull();
    w.onFrame({ type: 'turn_started', conversationId: c, turnId: 'b' }, 0, 10);
    expect(w.onFrame({ type: 'turn_ended', conversationId: c, turnId: 'b', stopReason: 'cancelled' }, 60_000, 10)).toBeNull();
    expect(w.onFrame({ type: 'turn_ended', conversationId: c, turnId: 'z', stopReason: 'stop' }, 60_000, 10)).toBeNull();
    // Tras perder la conexión, lo que estaba en vuelo se olvida.
    w.onFrame({ type: 'turn_started', conversationId: c, turnId: 'd' }, 0, 10);
    w.reset();
    expect(w.onFrame({ type: 'turn_ended', conversationId: c, turnId: 'd', stopReason: 'stop' }, 60_000, 10)).toBeNull();
  });

  it('una confirmación o unas preguntas pendientes piden atención siempre', () => {
    const w = new TurnWatch();
    expect(w.onFrame({ type: 'confirm_request', conversationId: c, callId: 'x' }, 0, 10)).toEqual({
      kind: 'attention',
      conversationId: c,
      what: 'confirm',
    });
    expect(w.onFrame({ type: 'questions_request', conversationId: c }, 0, 10)).toMatchObject({ what: 'questions' });
    expect(w.onFrame({ type: 'agent_event', conversationId: c }, 0, 10)).toBeNull();
  });

  it('textos', () => {
    expect(formatElapsed(45_000)).toBe('45 s');
    expect(formatElapsed(120_000)).toBe('2 min');
    expect(formatElapsed(125_400)).toBe('2 min 5 s');
    const turn = { kind: 'turn' as const, conversationId: c, elapsedMs: 42_000, stopReason: 'stop' };
    expect(notificationText(turn, 'Informe trimestral')).toEqual({
      title: 'Stratum · Informe trimestral',
      body: 'Respuesta lista (42 s).',
    });
    expect(notificationText({ ...turn, stopReason: 'error' }, null).body).toContain('error');
    expect(notificationText({ ...turn, stopReason: 'max_iterations' }, '  ').title).toBe('Stratum');
    expect(notificationText({ kind: 'attention', conversationId: c, what: 'confirm' }, 'X').body).toContain('confirmación');
  });
});

describe('applied.os / providerReady (D6)', () => {
  it('toma los valores del sidecar y rellena lo que falte con los defaults', () => {
    const a = configApplied({
      ok: true,
      error: null,
      restartRequired: [],
      os: { notifications: { enabled: false, minSeconds: 30 }, globalHotkey: '' },
      providerReady: false,
    });
    expect(a?.os).toEqual({
      notifications: { enabled: false, minSeconds: 30 },
      globalHotkey: '',
      updates: { autoCheck: true },
    });
    expect(osPrefs({ updates: { autoCheck: false } }).updates).toEqual({ autoCheck: false });
    expect(a?.providerReady).toBe(false);
    expect(osPrefs({ notifications: { minSeconds: -4 } })).toEqual({
      notifications: { enabled: true, minSeconds: 10 },
      globalHotkey: 'CommandOrControl+Shift+Space',
      updates: { autoCheck: true },
    });
    // Sin el campo, no se lanza el onboarding.
    expect(configApplied({ ok: true, error: null })?.providerReady).toBe(true);
  });
});

function fakeConfig(overrides: Partial<Config> = {}): Config {
  return {
    ...initialConfigState,
    loaded: true,
    snapshot: { path: '/h/.stratum/.stratumrc.json', exists: false, text: '', hash: null, parseError: null, readOnly: null, overrides: [] },
    dirty: false,
    load: vi.fn(),
    edit: vi.fn(),
    save: vi.fn(),
    discard: vi.fn(),
    takeDisk: vi.fn(),
    keepMine: vi.fn(),
    dismissNotice: vi.fn(),
    probe: vi.fn(() => 'p1'),
    probeResult: vi.fn(() => null),
    usage: null,
    refreshUsage: vi.fn(),
    retention: { running: false, report: null },
    runRetention: vi.fn(),
    restartAgent: vi.fn(),
    ...overrides,
  };
}

describe('Onboarding (D6)', () => {
  it('bienvenida → wizard; «Ahora no» lo aparca', () => {
    const onSkip = vi.fn();
    render(<Onboarding config={fakeConfig()} providerReady={false} configExists={false} onDone={vi.fn()} onSkip={onSkip} />);
    expect(screen.getByRole('dialog', { name: /bienvenida a Stratum/ })).toBeTruthy();
    expect(screen.getByText(/mismo fichero que usa la CLI/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Ahora no' }));
    expect(onSkip).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Conectar un modelo' }));
    // El ProviderWizard de Ajustes, primer paso: el tipo de servidor.
    expect(screen.queryByRole('dialog', { name: /bienvenida/ })).toBeNull();
    expect(screen.getAllByRole('button').length).toBeGreaterThan(1);
  });

  it('con el fichero roto no deja empezar y dice dónde arreglarlo', () => {
    const config = fakeConfig({
      snapshot: { path: '/x', exists: true, text: '{', hash: 'h', parseError: 'Unexpected end', readOnly: null, overrides: [] },
    });
    render(<Onboarding config={config} providerReady={false} configExists onDone={vi.fn()} onSkip={vi.fn()} />);
    expect(screen.getByRole('alert').textContent).toContain('Avanzado');
    expect((screen.getByRole('button', { name: 'Conectar un modelo' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('termina cuando el sidecar aplica una config con provider', () => {
    const onDone = vi.fn();
    const { rerender } = render(
      <Onboarding config={fakeConfig()} providerReady={false} configExists={false} onDone={onDone} onSkip={vi.fn()} />,
    );
    // Sin haber guardado nada, un provider que aparece (la CLI) no cierra la bienvenida…
    rerender(<Onboarding config={fakeConfig()} providerReady configExists onDone={onDone} onSkip={vi.fn()} />);
    expect(onDone).not.toHaveBeenCalled();
  });
});

describe('StartupFailure (D6)', () => {
  it('muestra el motivo, las últimas líneas del log y los botones', async () => {
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === 'logs_tail') return { path: '/logs/sidecar.log', text: 'boom: EADDRINUSE' };
      return undefined;
    });
    const onRetry = vi.fn();
    render(<StartupFailure message="no se encuentra el sidecar" onRetry={onRetry} />);
    expect(screen.getByText('no se encuentra el sidecar')).toBeTruthy();
    await waitFor(() => expect(screen.getByText('boom: EADDRINUSE')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(onRetry).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Ver logs' }));
    expect(invoke).toHaveBeenCalledWith('logs_open');
  });
});

describe('HotkeySetting (D6)', () => {
  function setup(value: Record<string, unknown> = {}, registerError: string | null = null) {
    const updates: Array<Record<string, unknown>> = [];
    const ctx: FieldContext = {
      value,
      defaults: { desktop: { globalHotkey: 'CommandOrControl+Shift+Space' } },
      issues: [],
      update: (fn) => updates.push(fn(value)),
    };
    render(<HotkeySetting ctx={ctx} registerError={registerError} />);
    return { updates, input: screen.getByLabelText(/Atajo para traer/) };
  }

  it('captura la combinación pulsada y la normaliza', () => {
    const { updates, input } = setup();
    fireEvent.keyDown(input, { key: 'k', code: 'KeyK', ctrlKey: true, altKey: true });
    expect(updates.at(-1)).toEqual({ desktop: { globalHotkey: 'CommandOrControl+Alt+K' } });
  });

  it('una tecla sin modificador no vale; Retroceso vuelve al default; Desactivar deja ""', () => {
    const { updates, input } = setup({ desktop: { globalHotkey: 'Alt+J' } });
    fireEvent.keyDown(input, { key: 'j', code: 'KeyJ' });
    expect(screen.getByText(/Esa combinación no vale/)).toBeTruthy();
    expect(updates).toHaveLength(0);
    fireEvent.keyDown(input, { key: 'Backspace', code: 'Backspace' });
    expect(updates.at(-1)).toEqual({});
    fireEvent.click(screen.getByRole('button', { name: 'Desactivar' }));
    expect(updates.at(-1)).toEqual({ desktop: { globalHotkey: '' } });
  });

  it('muestra el error de registro de Rust', () => {
    setup({}, 'no se pudo registrar «Alt+J» (¿lo usa otra aplicación?)');
    expect(screen.getByRole('alert').textContent).toContain('otra aplicación');
  });
});
