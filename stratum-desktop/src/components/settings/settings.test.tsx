import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { SECRET_PLACEHOLDER, type ConfigSnapshot } from '../../ipc/types';
import {
  configReducer,
  initialConfigState,
  isDirty,
  type Config,
  type ConfigState,
} from '../../hooks/useConfig';
import { sidecarReducer, initialSidecarState } from '../../hooks/useSidecar';
import {
  editDraft,
  numberField,
  removeProvider,
  setIn,
  upsertProvider,
} from './config-draft';
import { tokenizeJson } from './json-highlight';
import { SettingsPanel } from './SettingsPanel';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), Channel: class {} }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));

afterEach(cleanup);

const APPLIED = {
  ok: true,
  error: null,
  restartRequired: [] as string[],
  os: { notifications: { enabled: true, minSeconds: 10 }, globalHotkey: 'CommandOrControl+Shift+Space' },
  providerReady: true,
};

const snap = (text: string, hash = 'a'.repeat(64)): ConfigSnapshot => ({
  path: '/home/u/.stratum/.stratumrc.json',
  exists: true,
  text,
  hash,
  parseError: null,
  readOnly: null,
  overrides: [],
});

const CONFIG = JSON.stringify(
  {
    provider: {
      default: 'local',
      providers: {
        local: { type: 'openai-compatible', baseUrl: 'http://localhost:8080/v1', model: 'gemma', apiKey: '' },
        nube: {
          type: 'openai-compatible',
          baseUrl: 'https://api.openai.com/v1',
          model: 'gpt',
          apiKey: SECRET_PLACEHOLDER,
        },
      },
    },
  },
  null,
  2,
);

describe('borrador de la config (D5)', () => {
  it('setIn borra con undefined y poda los objetos vacíos', () => {
    const v = setIn({ tools: { webSearch: { maxResults: 5 } }, agent: {} }, ['tools', 'webSearch', 'maxResults'], undefined);
    expect(v).toEqual({ agent: {} });
    expect(setIn({}, ['a', 'b'], 1)).toEqual({ a: { b: 1 } });
  });

  it('upsert y remove de providers mantienen un default válido, como la CLI', () => {
    let v = upsertProvider({}, 'a', { baseUrl: 'x' }, false);
    expect(v).toEqual({ provider: { default: 'a', providers: { a: { baseUrl: 'x' } } } });
    v = upsertProvider(v, 'b', { baseUrl: 'y' }, false);
    expect((v.provider as { default: string }).default).toBe('a');
    v = upsertProvider(v, 'c', { baseUrl: 'z' }, true);
    expect((v.provider as { default: string }).default).toBe('c');
    v = removeProvider(v, 'c');
    expect((v.provider as { default: string }).default).toBe('a');
    expect(removeProvider(removeProvider(v, 'a'), 'b')).toEqual({});
  });

  it('un borrador que no es JSON no se toca desde los formularios', () => {
    expect(editDraft('{"a":', (v) => v)).toBeNull();
    expect(editDraft('', (v) => ({ ...v, x: 1 }))).toBe('{\n  "x": 1\n}');
    expect(numberField(' 2,5 ')).toBe(2.5);
    expect(numberField('')).toBeUndefined();
    expect(numberField('abc')).toBeNull();
  });
});

describe('resaltado JSON (D5)', () => {
  it('no pierde ni un carácter, también con texto a medio escribir', () => {
    for (const text of [CONFIG, '{ "a": [1, -2.5e3, true, null], "b": "x\\"y" }', '{ "roto": "sin cerrar\n  , 12tx']) {
      expect(tokenizeJson(text).map((t) => t.text).join('')).toBe(text);
    }
    const kinds = tokenizeJson('{"k": "v", "n": 3}').map((t) => `${t.kind}:${t.text}`);
    expect(kinds).toContain('key:"k"');
    expect(kinds).toContain('string:"v"');
    expect(kinds).toContain('number:3');
  });
});

describe('configReducer (D5, 15.7)', () => {
  const loaded = (): ConfigState =>
    configReducer(initialConfigState, {
      type: 'state',
      reason: 'requested',
      snapshot: snap('{}'),
      applied: { ...APPLIED, restartRequired: [] },
      defaults: {},
    });

  it('un cambio externo sin cambios locales se recarga solo y lo avisa', () => {
    const s = configReducer(loaded(), {
      type: 'state',
      reason: 'external',
      snapshot: snap('{"a":1}', 'b'.repeat(64)),
      applied: null,
      defaults: null,
    });
    expect(s.draft).toBe('{"a":1}');
    expect(s.baseHash).toBe('b'.repeat(64));
    expect(s.notice).toMatch(/fuera de la app/);
    expect(isDirty(s)).toBe(false);
  });

  it('con cambios sin guardar no pisa el borrador: pregunta', () => {
    let s = configReducer(loaded(), { type: 'edit', text: '{"mio":1}' });
    s = configReducer(s, {
      type: 'state',
      reason: 'external',
      snapshot: snap('{"cli":1}', 'c'.repeat(64)),
      applied: null,
      defaults: null,
    });
    expect(s.draft).toBe('{"mio":1}');
    expect(s.external?.text).toBe('{"cli":1}');

    const kept = configReducer(s, { type: 'keep_mine' });
    expect(kept.draft).toBe('{"mio":1}');
    expect(kept.baseHash).toBe('c'.repeat(64));
    expect(kept.external).toBeNull();
    expect(isDirty(kept)).toBe(true);

    const taken = configReducer(s, { type: 'take_disk', snapshot: s.external! });
    expect(taken.draft).toBe('{"cli":1}');
    expect(isDirty(taken)).toBe(false);
  });

  it('conflicto al guardar y guardado confirmado', () => {
    let s = configReducer(loaded(), { type: 'edit', text: '{"x":1}' });
    s = configReducer(s, { type: 'saving' });
    s = configReducer(s, { type: 'conflict', snapshot: snap('{"y":1}', 'd'.repeat(64)) });
    expect(s.saving).toBe(false);
    expect(s.conflict?.hash).toBe('d'.repeat(64));
    expect(s.draft).toBe('{"x":1}');
    s = configReducer(s, {
      type: 'state',
      reason: 'saved',
      snapshot: snap('{"x":1}', 'e'.repeat(64)),
      applied: { ...APPLIED, restartRequired: [] },
      defaults: null,
    });
    expect(s.conflict).toBeNull();
    expect(s.notice).toBe('Guardado.');
    expect(isDirty(s)).toBe(false);
  });

  it('una config aplicada retira el error de config del arranque', () => {
    const withError = sidecarReducer(initialSidecarState, {
      type: 'frame',
      now: 0,
      frame: { type: 'sidecar_error', fatal: true, code: 'config_invalid', message: 'rota' },
    });
    expect(withError.errors).toHaveLength(1);
    const cleared = sidecarReducer(withError, {
      type: 'frame',
      now: 0,
      frame: {
        type: 'config_state',
        reason: 'saved',
        snapshot: snap('{}'),
        applied: { ...APPLIED, restartRequired: [] },
        defaults: {},
      },
    });
    expect(cleared.errors).toHaveLength(0);
  });
});

function fakeConfig(overrides: Partial<Config> = {}): Config {
  const base: ConfigState = {
    ...initialConfigState,
    loaded: true,
    snapshot: snap(CONFIG),
    applied: { ...APPLIED, restartRequired: [] },
    defaults: { tools: { webSearch: { maxResults: 10 } } },
    draft: CONFIG,
    baseText: CONFIG,
    baseHash: 'a'.repeat(64),
  };
  const state = { ...base, ...overrides } as Config;
  return {
    ...state,
    dirty: state.draft !== state.baseText,
    load: vi.fn(),
    edit: vi.fn(),
    save: vi.fn(),
    discard: vi.fn(),
    takeDisk: vi.fn(),
    keepMine: vi.fn(),
    dismissNotice: vi.fn(),
    probe: vi.fn(() => 'p1'),
    probeResult: vi.fn(() => ({ requestId: 'p1', models: ['llama3', 'qwen'] })),
    usage: null,
    refreshUsage: vi.fn(),
    retention: { running: false, report: null },
    runRetention: vi.fn(),
    restartAgent: vi.fn(),
    ...overrides,
  };
}

function renderPanel(config: Config) {
  const onClose = vi.fn();
  render(<SettingsPanel config={config} connected onClose={onClose} onOpenMemory={vi.fn()} />);
  return { onClose };
}

describe('SettingsPanel (D5)', () => {
  it('lista los providers sin enseñar la key y cambia el default en el borrador', () => {
    const config = fakeConfig();
    renderPanel(config);
    expect(screen.getByText('local')).toBeTruthy();
    expect(screen.getByText(/key guardada/)).toBeTruthy();
    expect(document.body.textContent).not.toContain('sk-');
    fireEvent.click(screen.getByRole('button', { name: 'Usar por defecto' }));
    const text = vi.mocked(config.edit).mock.calls[0][0];
    expect(JSON.parse(text).provider.default).toBe('nube');
  });

  it('el wizard sondea los modelos por el sidecar y termina guardando', () => {
    const config = fakeConfig();
    renderPanel(config);
    fireEvent.click(screen.getByRole('button', { name: 'Añadir provider' }));
    fireEvent.click(screen.getByRole('button', { name: /Ollama/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Siguiente' }));
    fireEvent.change(screen.getByLabelText('Nombre (alias)'), { target: { value: 'local' } });
    fireEvent.click(screen.getByRole('button', { name: 'Siguiente' }));
    expect(screen.getByRole('alert').textContent).toMatch(/Ya existe/);
    fireEvent.change(screen.getByLabelText('Nombre (alias)'), { target: { value: 'ollama' } });
    fireEvent.click(screen.getByRole('button', { name: 'Siguiente' }));
    expect(config.probe).toHaveBeenCalledWith({ baseUrl: 'http://localhost:11434/v1', apiKey: 'ollama' });
    fireEvent.click(screen.getByRole('option', { name: 'qwen' }));
    fireEvent.click(screen.getByRole('button', { name: 'Siguiente' }));
    fireEvent.click(screen.getByLabelText(/Usarlo por defecto/));
    const wizard = screen.getByRole('dialog', { name: /Añadir provider/ });
    fireEvent.click(within(wizard).getByRole('button', { name: 'Guardar' }));
    const saved = vi.mocked(config.save).mock.calls[0][0]!;
    const value = JSON.parse(saved.text!);
    expect(value.provider.providers.ollama).toMatchObject({
      baseUrl: 'http://localhost:11434/v1',
      model: 'qwen',
      apiKey: 'ollama',
    });
    expect(value.provider.default).toBe('ollama');
    // Los demás providers siguen intactos, key enmascarada incluida.
    expect(value.provider.providers.nube.apiKey).toBe(SECRET_PLACEHOLDER);
  });

  it('editar un provider no reenvía su key guardada a otra URL', () => {
    const config = fakeConfig();
    renderPanel(config);
    fireEvent.click(screen.getAllByRole('button', { name: 'Editar' })[1]);
    fireEvent.change(screen.getByLabelText('Base URL'), { target: { value: 'https://otro.example/v1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Siguiente' }));
    expect(screen.getByRole('alert').textContent).toMatch(/otro servidor/);
    expect(config.probe).not.toHaveBeenCalled();
  });

  it('Avanzado marca el JSON inválido antes de guardar', () => {
    const config = fakeConfig({
      draft: '{\n  "agent": \n}',
      issues: [{ path: '', message: 'JSON no válido', line: 3, column: 1 }],
    });
    renderPanel(config);
    fireEvent.click(screen.getByRole('tab', { name: /Avanzado/ }));
    expect(screen.getByText(/línea 3, columna 1/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Guardar' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('tab', { name: /Providers/ }));
    expect(screen.getByText(/no es JSON válido/)).toBeTruthy();
  });

  it('conflicto, cambio externo y reinicio pendiente ofrecen su acción', () => {
    const config = fakeConfig({
      draft: `${CONFIG} `,
      conflict: snap('{}', 'f'.repeat(64)),
      applied: { ...APPLIED, restartRequired: ['Carpeta de los espacios de trabajo'] },
    });
    renderPanel(config);
    fireEvent.click(screen.getByRole('button', { name: 'Sobrescribir con la mía' }));
    expect(config.save).toHaveBeenCalledWith({ force: true });
    fireEvent.click(screen.getByRole('button', { name: 'Reiniciar el agente' }));
    expect(config.restartAgent).toHaveBeenCalled();
    cleanup();

    const external = fakeConfig({ draft: `${CONFIG} `, external: snap('{}', 'f'.repeat(64)) });
    renderPanel(external);
    fireEvent.click(screen.getByRole('button', { name: 'Mantener mis cambios' }));
    expect(external.keepMine).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Descartar mis cambios' }));
    expect(external.takeDisk).toHaveBeenCalled();
  });

  it('cerrar con cambios sin guardar pide confirmación', () => {
    const config = fakeConfig({ draft: `${CONFIG} ` });
    const { onClose } = renderPanel(config);
    fireEvent.click(screen.getByRole('button', { name: /Cerrar ajustes/ }));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Descartar y cerrar' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('un número vacío vuelve al default y se muestra como placeholder', () => {
    const config = fakeConfig();
    renderPanel(config);
    fireEvent.click(screen.getByRole('tab', { name: /Búsqueda web/ }));
    const input = screen.getByLabelText('Resultados por búsqueda') as HTMLInputElement;
    expect(input.placeholder).toBe('10');
    fireEvent.change(input, { target: { value: '7' } });
    expect(JSON.parse(vi.mocked(config.edit).mock.calls.at(-1)![0]).tools.webSearch.maxResults).toBe(7);
  });

  it('Purgar ahora pide confirmación antes de lanzar la retención', () => {
    const config = fakeConfig();
    renderPanel(config);
    fireEvent.click(screen.getByRole('tab', { name: /Espacios de trabajo/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Purgar ahora' }));
    expect(config.runRetention).not.toHaveBeenCalled();
    const buttons = screen.getAllByRole('button', { name: 'Purgar ahora' });
    fireEvent.click(buttons[buttons.length - 1]);
    expect(config.runRetention).toHaveBeenCalled();
  });
});
