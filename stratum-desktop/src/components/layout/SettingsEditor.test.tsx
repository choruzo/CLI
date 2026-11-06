import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CommandError, NativeBridge } from '../../ipc/native';
import type {
  ProviderFieldMeta,
  SettingsChange,
  SettingsField,
  SettingsProvider,
  SettingsView,
} from '../../ipc/settings';
import { SettingsEditor } from './SettingsEditor';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));

afterEach(cleanup);

const field = (overrides: Partial<SettingsField>): SettingsField => ({
  path: 'logging.stderr',
  label: 'Log por la salida de errores',
  hint: '',
  kind: 'bool',
  options: [],
  min: null,
  max: null,
  level: 'A',
  value: true,
  default: true,
  isDefault: true,
  restart: 'daemon',
  secret: null,
  locked: null,
  ...overrides,
});

const providerFields: ProviderFieldMeta[] = [
  { name: 'baseUrl', label: 'Dirección (baseUrl)', hint: '', kind: 'url', min: null, max: null, level: 'B' },
  { name: 'model', label: 'Modelo por defecto', hint: '', kind: 'text', min: null, max: null, level: 'A' },
  { name: 'contextWindow', label: 'Ventana de contexto', hint: '', kind: 'int', min: 1, max: 100000000, level: 'A' },
  { name: 'apiKey', label: 'Clave de API', hint: '', kind: 'secret', min: null, max: null, level: 'B' },
];

const nube: SettingsProvider = {
  alias: 'nube',
  isDefault: true,
  baseUrl: 'https://api.example/v1',
  model: 'gran-modelo',
  contextWindow: 32768,
  apiKey: { set: true, envVar: null },
};

const local: SettingsProvider = {
  alias: 'local',
  isDefault: false,
  baseUrl: 'http://localhost:11434/v1',
  model: '',
  contextWindow: null,
  apiKey: { set: true, envVar: 'OLLAMA_KEY' },
};

function sampleView(overrides: Partial<SettingsView> = {}): SettingsView {
  return {
    configPath: '/home/ana/.stratum/.stratumrc.json',
    state: 'ready',
    reason: null,
    cli: 'ok',
    defaultProvider: 'nube',
    providers: [nube, local],
    providerFields,
    sections: [
      {
        id: 'logging',
        title: 'Registro y trazas',
        intro: '',
        fields: [
          field({}),
          field({ path: 'logging.redact', label: 'Ocultar secretos en el log', level: 'B' }),
          field({
            path: 'daemon.maxSessions',
            label: 'Sesiones vivas a la vez',
            kind: 'int',
            min: 1,
            max: 256,
            value: 16,
            default: 16,
            restart: 'daemon',
          }),
        ],
      },
      {
        id: 'tools',
        title: 'Herramientas',
        intro: '',
        fields: [
          field({
            path: 'tools.webSearch.apiKey',
            label: 'Buscador web: clave',
            kind: 'secret',
            level: 'B',
            value: null,
            default: null,
            isDefault: false,
            secret: { set: true, envVar: null },
          }),
        ],
      },
    ],
    cliOnly: [
      { title: 'Servidores MCP (lanzan procesos)', present: true },
      { title: 'Plugins (ejecutan código)', present: false },
    ],
    ...overrides,
  };
}

const change = (view: SettingsView, restart: SettingsChange['restart'] = 'session', changed = true): SettingsChange => ({
  view,
  changed,
  restart,
});

function bridge(overrides: Partial<NativeBridge> = {}): NativeBridge {
  return {
    settingsGet: vi.fn(async () => sampleView()),
    settingsSet: vi.fn(async () => change(sampleView())),
    settingsAddProvider: vi.fn(async () => change(sampleView())),
    ...overrides,
  } as unknown as NativeBridge;
}

const mount = async (native: NativeBridge) => {
  const utils = render(<SettingsEditor native={native} />);
  await waitFor(() => expect(screen.getByText('Registro y trazas')).toBeTruthy());
  return utils;
};

const row = (path: string) => document.querySelector(`[data-path="${path}"]`) as HTMLElement;

describe('SettingsEditor: la configuración global de Stratum', () => {
  it('agrupa por secciones, enseña el nivel de cada campo y lo que es solo de la CLI', async () => {
    await mount(bridge());
    expect(screen.getByText('Herramientas')).toBeTruthy();
    // Nivel B: candado; nivel A: nada.
    expect(within(row('logging.redact')).getByText('Pide confirmar')).toBeTruthy();
    expect(within(row('logging.stderr')).queryByText('Pide confirmar')).toBeNull();
    // Nivel C: aparte, sin editar, diciendo solo si hay algo.
    const cliOnly = screen.getByText('Solo desde la CLI').closest('section') as HTMLElement;
    expect(within(cliOnly).getByText('Servidores MCP (lanzan procesos)')).toBeTruthy();
    expect(within(cliOnly).getByText('definido')).toBeTruthy();
    expect(within(cliOnly).getByText('sin definir')).toBeTruthy();
    expect(within(cliOnly).queryAllByRole('textbox')).toHaveLength(0);
    expect(within(cliOnly).queryAllByRole('checkbox')).toHaveLength(0);
    // Por defecto frente a fijado.
    expect(within(row('logging.stderr')).getByText('por defecto')).toBeTruthy();
  });

  it('un cambio de nivel A se guarda al momento y se enseña lo que el lado nativo ha releído', async () => {
    const after = sampleView();
    after.sections[0]!.fields[0] = field({ value: false, isDefault: false });
    const native = bridge({ settingsSet: vi.fn(async () => change(after, 'daemon')) });
    await mount(native);
    fireEvent.click(within(row('logging.stderr')).getByRole('checkbox'));
    await waitFor(() => expect(native.settingsSet).toHaveBeenCalledWith('logging.stderr', false));
    await waitFor(() => expect(within(row('logging.stderr')).getByText('Guardado')).toBeTruthy());
    expect((within(row('logging.stderr')).getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
    // Y avisa de qué hay que reiniciar para esa clave.
    expect(screen.getByText(/reinicia el daemon/)).toBeTruthy();
  });

  it('un cambio de nivel B espera la confirmación nativa y solo entonces dice «guardado»', async () => {
    let finish: (c: SettingsChange) => void = () => undefined;
    const native = bridge({
      settingsSet: vi.fn(
        () =>
          new Promise<SettingsChange>((resolve) => {
            finish = resolve;
          }),
      ),
    });
    await mount(native);
    fireEvent.click(within(row('logging.redact')).getByRole('checkbox'));
    await waitFor(() =>
      expect(within(row('logging.redact')).getByText(/Confirma el cambio en la ventana/)).toBeTruthy(),
    );
    expect(native.settingsSet).toHaveBeenCalledWith('logging.redact', false);
    // Mientras tanto no se puede tocar otra vez.
    expect((within(row('logging.redact')).getByRole('checkbox') as HTMLInputElement).disabled).toBe(true);
    finish(change(sampleView()));
    await waitFor(() => expect(within(row('logging.redact')).getByText('Guardado')).toBeTruthy());
  });

  it('si la confirmación no llega (ventana cerrada, caducada) enseña el motivo y no marca nada como guardado', async () => {
    const error: CommandError = {
      kind: 'not-confirmed',
      code: null,
      reason: 'cancelled',
      message: 'Sin confirmar. No se ha escrito nada.',
    };
    const native = bridge({ settingsSet: vi.fn(async () => Promise.reject(error)) });
    await mount(native);
    fireEvent.click(within(row('logging.redact')).getByRole('checkbox'));
    await waitFor(() =>
      expect(within(row('logging.redact')).getByText('Sin confirmar. No se ha escrito nada.')).toBeTruthy(),
    );
    expect(within(row('logging.redact')).queryByText('Guardado')).toBeNull();
    // El valor que se enseña sigue siendo el del fichero.
    expect((within(row('logging.redact')).getByRole('checkbox') as HTMLInputElement).checked).toBe(true);
  });

  it('el fallo de la CLI se enseña tal cual', async () => {
    const error: CommandError = {
      kind: 'rejected',
      code: null,
      reason: null,
      message: 'La CLI de Stratum no ha aceptado el cambio y el fichero sigue como estaba: logging.level: Invalid enum value',
    };
    const native = bridge({ settingsSet: vi.fn(async () => Promise.reject(error)) });
    await mount(native);
    fireEvent.click(within(row('logging.stderr')).getByRole('checkbox'));
    await waitFor(() => expect(screen.getByText(/Invalid enum value/)).toBeTruthy());
  });

  it('un número se valida en el formulario antes de pedirlo, y sale tipado', async () => {
    const native = bridge();
    await mount(native);
    const input = within(row('daemon.maxSessions')).getByRole('textbox') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '0' } });
    fireEvent.click(within(row('daemon.maxSessions')).getByRole('button', { name: /Guardar/ }));
    expect(screen.getByText('Mínimo 1.')).toBeTruthy();
    fireEvent.change(input, { target: { value: 'muchas' } });
    fireEvent.click(within(row('daemon.maxSessions')).getByRole('button', { name: /Guardar/ }));
    expect(screen.getByText('Escribe un número.')).toBeTruthy();
    expect(native.settingsSet).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: '8' } });
    fireEvent.click(within(row('daemon.maxSessions')).getByRole('button', { name: /Guardar/ }));
    await waitFor(() => expect(native.settingsSet).toHaveBeenCalledWith('daemon.maxSessions', 8));
  });

  it('una clave de API guardada no se enseña; la nueva viaja una vez y no queda en la pantalla', async () => {
    const native = bridge();
    await mount(native);
    const card = screen.getByLabelText('Provider nube');
    expect(within(card).getByText('Guardada (no se muestra)')).toBeTruthy();
    // La de `local` viene de una variable: se enseña su nombre, que no es secreto.
    expect(within(screen.getByLabelText('Provider local')).getByText(/variable de entorno OLLAMA_KEY/)).toBeTruthy();
    fireEvent.click(within(card).getByRole('button', { name: 'Cambiar' }));
    const input = within(card).getByLabelText('Clave de API: clave nueva') as HTMLInputElement;
    // No es un campo de contraseña del sistema: es texto pintado con puntos.
    expect(input.type).toBe('text');
    fireEvent.change(input, { target: { value: 'sk-NUEVA-MUY-SECRETA' } });
    fireEvent.click(within(card).getByRole('button', { name: 'Guardar' }));
    await waitFor(() =>
      expect(native.settingsSet).toHaveBeenCalledWith('provider.providers.nube.apiKey', 'sk-NUEVA-MUY-SECRETA'),
    );
    await waitFor(() => expect(within(card).queryByLabelText('Clave de API: clave nueva')).toBeNull());
    expect(document.body.innerHTML).not.toContain('NUEVA-MUY-SECRETA');
    expect(document.body.textContent).not.toContain('NUEVA-MUY-SECRETA');
  });

  it('la respuesta que recibe el webview no lleva ningún valor de secreto', () => {
    const view = sampleView();
    const text = JSON.stringify(view);
    expect(text).not.toMatch(/sk-|apiKey":"|secret":\{"set":true,"envVar":null,"value/);
    for (const p of view.providers) expect(Object.keys(p.apiKey).sort()).toEqual(['envVar', 'set']);
  });

  it('editar un provider usa su ruta, y la dirección tapada no se edita a ciegas', async () => {
    const masked = sampleView({ providers: [{ ...nube, baseUrl: 'https://••••@api.example/v1?••••' }] });
    const native = bridge({ settingsGet: vi.fn(async () => masked) });
    await mount(native);
    const url = row('provider.providers.nube.baseUrl');
    expect((within(url).getByRole('textbox') as HTMLInputElement).disabled).toBe(true);
    expect(within(url).getByText(/edítala con `stratum config`/)).toBeTruthy();
    const model = row('provider.providers.nube.model');
    fireEvent.change(within(model).getByRole('textbox'), { target: { value: 'otro' } });
    fireEvent.click(within(model).getByRole('button', { name: /Guardar/ }));
    await waitFor(() => expect(native.settingsSet).toHaveBeenCalledWith('provider.providers.nube.model', 'otro'));
  });

  it('«Usar por defecto» cambia provider.default', async () => {
    const native = bridge();
    await mount(native);
    fireEvent.click(within(screen.getByLabelText('Provider local')).getByRole('button', { name: 'Usar por defecto' }));
    await waitFor(() => expect(native.settingsSet).toHaveBeenCalledWith('provider.default', 'local'));
  });

  it('añadir un provider pide todo de una vez, con confirmación, y vacía la clave', async () => {
    const native = bridge();
    await mount(native);
    fireEvent.click(screen.getByRole('button', { name: 'Añadir un provider' }));
    const form = screen.getByRole('form', { name: 'Añadir un provider' });
    fireEvent.change(within(form).getByLabelText('Alias'), { target: { value: ' otro ' } });
    fireEvent.change(within(form).getByLabelText('Dirección (baseUrl)'), { target: { value: 'https://x.example/v1' } });
    fireEvent.change(within(form).getByLabelText('Clave de API'), { target: { value: 'sk-DEL-FORMULARIO' } });
    fireEvent.change(within(form).getByLabelText('Modelo por defecto'), { target: { value: 'm1' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Añadir' }));
    await waitFor(() =>
      expect(native.settingsAddProvider).toHaveBeenCalledWith({
        alias: 'otro',
        baseUrl: 'https://x.example/v1',
        apiKey: 'sk-DEL-FORMULARIO',
        model: 'm1',
        makeDefault: true,
      }),
    );
    await waitFor(() => expect(screen.getByRole('button', { name: 'Añadir un provider' })).toBeTruthy());
    expect(document.body.innerHTML).not.toContain('sk-DEL-FORMULARIO');
  });

  it('con una CLI vieja o ausente el editor es de solo lectura y no deja guardar nada', async () => {
    const view = sampleView({
      state: 'readOnly',
      cli: 'outdated',
      reason: 'Tu CLI de Stratum es anterior a los ajustes editables: actualiza la CLI.',
    });
    const native = bridge({ settingsGet: vi.fn(async () => view) });
    await mount(native);
    expect(screen.getByRole('alert').textContent).toMatch(/actualiza la CLI/);
    for (const box of screen.getAllByRole('checkbox')) expect((box as HTMLInputElement).disabled).toBe(true);
    for (const input of screen.getAllByRole('textbox')) expect((input as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Añadir un provider' }) as HTMLButtonElement).disabled).toBe(true);
    for (const cambiar of screen.getAllByRole('button', { name: 'Cambiar' })) {
      expect((cambiar as HTMLButtonElement).disabled).toBe(true);
    }
    expect(native.settingsSet).not.toHaveBeenCalled();
  });

  it('un valor bloqueado (usa una variable de entorno) se enseña sin controles que lo pisen', async () => {
    const view = sampleView();
    view.sections[0]!.fields[2] = field({
      path: 'daemon.maxSessions',
      label: 'Sesiones vivas a la vez',
      kind: 'int',
      value: '${N}',
      locked: 'Usa una variable de entorno: edítalo con `stratum config`.',
    });
    await mount(bridge({ settingsGet: vi.fn(async () => view) }));
    const r = row('daemon.maxSessions');
    expect((within(r).getByRole('textbox') as HTMLInputElement).disabled).toBe(true);
    expect(within(r).getByText(/edítalo con `stratum config`/)).toBeTruthy();
  });

  it('si no se pueden leer los ajustes lo dice', async () => {
    const native = bridge({ settingsGet: vi.fn(async () => Promise.reject(new Error('rota'))) });
    render(<SettingsEditor native={native} />);
    await waitFor(() => expect(screen.getByText(/Error inesperado|rota/)).toBeTruthy());
  });
});
