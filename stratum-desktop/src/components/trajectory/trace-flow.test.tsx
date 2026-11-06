import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { handleDesktopEvent } from '../../client/bridge';
import { MAX_TRACE_RECORDS, traceActions, traceStore } from '../../client/trace-store';
import type { DesktopEvent, NativeBridge } from '../../ipc/native';
import { TRACE_FORMAT_VERSION } from '../../trace';
import { describeTraceUnavailable, parseTraceRecord, parseTraceRecords } from '../../trace/parse';
import { Sidebar, loadSidebarState } from '../layout/Sidebar';
import { TrajectoryPanel } from './TrajectoryPanel';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), Channel: class {} }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));

afterEach(cleanup);
beforeEach(() => traceActions.follow(null));

const SID = 'ses_20261012_abc123';

const batch = (records: unknown, over: Partial<{ sessionId: string; reset: boolean; format: number }> = {}) => ({
  sessionId: SID,
  reset: false,
  format: TRACE_FORMAT_VERSION,
  records,
  ...over,
});

const TURN = { t: 'turn', at: 1000, input: 'lee a.txt' };
const CALL = { t: 'begin', at: 1010, id: 'm1', kind: 'model', name: 'qwen', data: { origin: 'agent', provider: 'local' } };

describe('parseTraceRecords: el borde del webview', () => {
  it('descarta lo que no encaja, cuenta lo descartado y conserva lo válido', () => {
    const out = parseTraceRecords([
      TURN,
      { t: 'begin', at: 2, id: 'a', kind: 'model', name: 'm', data: { x: 1 }, extra: true },
      { t: 'begin', at: 2, id: 'b', kind: 'nope', name: 'm' },
      { t: 'end', at: 3, id: 'a', status: 'weird' },
      { t: 'end', at: 3, id: 'a', status: 'ok' },
      { t: 'meta', at: 0, v: 1, sessionId: 's', caps: ['runtime', 'llm-origin', 7], cwd: '/x' },
      { t: 'tipo-del-futuro', at: 4 },
      'basura',
      null,
    ]);
    expect(out?.records).toEqual([
      TURN,
      { t: 'begin', at: 2, id: 'a', kind: 'model', name: 'm', data: { x: 1 } },
      { t: 'end', at: 3, id: 'a', status: 'ok' },
      // De la cabecera solo pasa lo que el panel usa: los caps.
      { t: 'meta', at: 0, v: 1, sessionId: 's', caps: ['runtime', 'llm-origin'] },
    ]);
    expect(out?.rejected).toBe(5);
    expect(parseTraceRecords('no')).toBeNull();
    expect(parseTraceRecord({ t: 'turn', at: Number.NaN, input: 'x' })).toBeNull();
  });
});

describe('trace-store: lo que cuenta el daemon, reducido con el modelo del core', () => {
  it('reset sustituye, lo demás añade, y un lote de otra sesión se ignora', () => {
    traceActions.follow(SID);
    traceActions.apply(batch([TURN, CALL], { reset: true }));
    expect(traceStore.get().loaded).toBe(true);
    expect(traceStore.get().model.steps).toHaveLength(2);

    traceActions.apply(batch([{ t: 'end', at: 1200, id: 'm1', status: 'ok', data: { text: 'hola' } }]));
    expect(traceStore.get().model.steps[1]?.end).toBe(1200);

    // Otra sesión (llegado tras cambiar de foco): no entra.
    traceActions.apply(batch([TURN], { sessionId: 'otra', reset: true }));
    expect(traceStore.get().model.steps).toHaveLength(2);

    // Un reset (p. ej. tras reconectar) lo vacía y empieza de nuevo: es la autoridad.
    traceActions.apply(batch([TURN], { reset: true }));
    expect(traceStore.get().model.steps).toHaveLength(1);
    expect(traceStore.get().count).toBe(1);
  });

  it('una traza que aún no existe llega como reset vacío: cargada, sin pasos', () => {
    traceActions.follow(SID);
    expect(traceStore.get().loaded).toBe(false);
    traceActions.apply(batch([], { reset: true }));
    expect(traceStore.get()).toMatchObject({ loaded: true, count: 0, unavailable: null });
  });

  it('cambiar de sesión olvida la traza anterior; pedir la misma no la toca', () => {
    traceActions.follow(SID);
    traceActions.apply(batch([TURN], { reset: true }));
    const before = traceStore.get();
    traceActions.follow(SID);
    expect(traceStore.get()).toBe(before);
    traceActions.follow('otra');
    expect(traceStore.get()).toMatchObject({ sessionId: 'otra', loaded: false, count: 0 });
    expect(traceStore.get().model.steps).toHaveLength(0);
  });

  it('un formato más nuevo o una tanda que no es una lista no se adivinan', () => {
    traceActions.follow(SID);
    traceActions.apply(batch([TURN], { format: TRACE_FORMAT_VERSION + 1, reset: true }));
    expect(traceStore.get().unavailable?.code).toBe('FORMAT');
    expect(traceStore.get().model.steps).toHaveLength(0);

    traceActions.apply(batch('no', { reset: true }));
    expect(traceStore.get().unavailable?.code).toBe('INVALID_TRACE');
  });

  it('el tope de registros se dice: no se guardan de más', () => {
    traceActions.follow(SID);
    const many = Array.from({ length: MAX_TRACE_RECORDS + 10 }, (_, i) => ({
      t: 'point',
      at: i,
      id: `p${i}`,
      kind: 'notice',
      name: 'n',
    }));
    traceActions.apply(batch(many, { reset: true }));
    expect(traceStore.get().count).toBe(MAX_TRACE_RECORDS);
    expect(traceStore.get().truncated).toBe(true);
  });

  it('los registros descartados se cuentan; una traza no disponible se dice y un reset la rehace', () => {
    traceActions.follow(SID);
    traceActions.apply(batch([TURN, 'basura'], { reset: true }));
    expect(traceStore.get().rejected).toBe(1);

    traceActions.unavailable(SID, 'UNAVAILABLE', 'peer-hosted');
    expect(traceStore.get()).toMatchObject({ unavailable: { code: 'UNAVAILABLE', reason: 'peer-hosted' }, loaded: false });
    // De una sesión que ya no se sigue, no.
    traceActions.unavailable('otra', 'NOT_FOUND', null);
    expect(traceStore.get().unavailable?.code).toBe('UNAVAILABLE');

    traceActions.apply(batch([TURN], { reset: true }));
    expect(traceStore.get().unavailable).toBeNull();
  });

  it('el puente reparte los eventos nativos al store', () => {
    traceActions.follow(SID);
    const native = {} as NativeBridge;
    const records: DesktopEvent = { type: 'trace-records', sessionId: SID, reset: true, format: 1, records: [TURN] };
    handleDesktopEvent(native, records);
    expect(traceStore.get().model.steps).toHaveLength(1);
    handleDesktopEvent(native, { type: 'trace-unavailable', sessionId: SID, code: 'NOT_FOUND', reason: null });
    expect(traceStore.get().unavailable?.code).toBe('NOT_FOUND');
  });
});

describe('describeTraceUnavailable', () => {
  it('explica en español por qué no hay trayectoria', () => {
    expect(describeTraceUnavailable('UNAVAILABLE', 'peer-hosted')).toContain('su propia terminal');
    expect(describeTraceUnavailable('NOT_FOUND', null)).toContain('no tiene la traza');
    expect(describeTraceUnavailable('QUE_SE_YO', null)).toContain('QUE_SE_YO');
  });
});

describe('TrajectoryPanel: estados', () => {
  const base = traceStore.get();
  const view = (over: Partial<typeof base> & { hasSession?: boolean; connected?: boolean } = {}) => {
    const { hasSession = true, connected = true, ...state } = over;
    return (
      <TrajectoryPanel
        trajectory={{ model: base.model, loaded: true, truncated: false, rejected: 0, unavailable: null, ...state }}
        hasSession={hasSession}
        connected={connected}
        onClose={() => {}}
      />
    );
  };

  it('sin sesión elegida lo dice', () => {
    render(view({ hasSession: false }));
    expect(screen.getByText('Elige una sesión para ver su trayectoria.')).toBeTruthy();
  });

  it('una traza que el daemon no sirve (sesión de terminal) explica por qué', () => {
    render(view({ unavailable: { code: 'UNAVAILABLE', reason: 'peer-hosted' } }));
    expect(screen.getByText(/corre en su propia terminal/)).toBeTruthy();
  });

  it('sin conexión, recortada o con registros omitidos, lo avisa', () => {
    traceActions.follow(SID);
    traceActions.apply(batch([TURN], { reset: true }));
    render(view({ model: traceStore.get().model, connected: false, truncated: true, rejected: 2 }));
    expect(screen.getByText(/Sin conexión con el daemon/)).toBeTruthy();
    expect(screen.getByText(/se muestran solo los primeros registros/)).toBeTruthy();
    expect(screen.getByText('2 registros de la traza no se pudieron leer y se han omitido.')).toBeTruthy();
  });
});

describe('el raíl abre y cierra el panel de trayectoria', () => {
  it('el botón refleja y conmuta', () => {
    const onToggle = vi.fn();
    const { rerender } = render(
      <Sidebar
        state={loadSidebarState()}
        onToggle={() => undefined}
        onSettings={() => undefined}
        trajectory={{ open: true, onToggle }}
      >
        <div />
      </Sidebar>,
    );
    const button = screen.getByRole('button', { name: 'Trayectoria (Ctrl+J)' });
    expect(button.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(button);
    expect(onToggle).toHaveBeenCalledOnce();
    rerender(
      <Sidebar state={loadSidebarState()} onToggle={() => undefined} onSettings={() => undefined}>
        <div />
      </Sidebar>,
    );
    expect(screen.queryByRole('button', { name: 'Trayectoria (Ctrl+J)' })).toBeNull();
  });
});
