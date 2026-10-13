import { beforeEach, describe, expect, it } from 'vitest';
import { startBridge } from './connect';
import { useConnection } from '../stores/connectionStore';
import { useSessions } from '../stores/sessionStore';
import { useUi } from '../stores/uiStore';
import { displayStatus } from '../protocol/view';
import {
  CONNECTED,
  SID,
  fakeNative,
  resetStores,
  runUpdated,
  sampleSession,
  snapshotOf,
  stateEvent,
} from '../testing/fixtures';

beforeEach(resetStores);

const entry = () => useSessions.getState().sessions[SID];

describe('del lado nativo a los stores', () => {
  it('arranca escuchando y después avisa de que está lista', async () => {
    const native = fakeNative();
    const order: string[] = [];
    native.onEvent = async () => {
      order.push('listen');
      return () => undefined;
    };
    native.calls.attach.mockImplementation(async () => {
      order.push('attach');
      return { dotVersion: '0.1.0', protocol: 1, trayAvailable: true };
    });
    await startBridge(native);
    expect(order).toEqual(['listen', 'attach']);
    expect(useConnection.getState().info?.dotVersion).toBe('0.1.0');
  });

  it('el estado de la conexión es el que dicta el lado nativo', () => {
    const native = fakeNative();
    native.push({ type: 'connection', state: { kind: 'daemon-starting' } });
    expect(useConnection.getState().state.kind).toBe('daemon-starting');
    native.push({ type: 'connection', state: CONNECTED });
    native.push({ type: 'connection', state: { kind: 'reconnecting', attempt: 2 } });
    expect(useConnection.getState().state).toEqual({ kind: 'reconnecting', attempt: 2 });
    // La versión del daemon se recuerda para el pie mientras se reconecta.
    expect(useConnection.getState().lastServerVersion).toBe('0.9.0');
  });

  it('D. una foto sustituye el estado de la sesión, no se fusiona', () => {
    const native = fakeNative();
    native.push({ type: 'sessions', sessionIds: [SID] });
    expect(entry()?.snapshot).toBeNull();
    native.push({ type: 'snapshot', sessionId: SID, snapshot: snapshotOf({ seq: 3 }) });
    native.push({ type: 'events', sessionId: SID, events: [runUpdated(4, 'paused')] });
    expect(entry()?.snapshot?.run?.status).toBe('paused');

    // Foto nueva (reconexión): lo anterior desaparece entero.
    native.push({ type: 'snapshot', sessionId: SID, snapshot: snapshotOf({ seq: 40 }, { model: 'otro-modelo' }) });
    expect(entry()?.snapshot?.seq).toBe(40);
    expect(entry()?.snapshot?.run?.status).toBe('running');
    expect(entry()?.snapshot?.session.model).toBe('otro-modelo');
    expect(entry()?.activity.slice(-1)[0]?.type).toBe('dot.resync');
  });

  it('E. un evento avanza la foto y deja una línea de actividad', () => {
    const native = fakeNative();
    native.push({ type: 'sessions', sessionIds: [SID] });
    native.push({ type: 'snapshot', sessionId: SID, snapshot: snapshotOf() });
    native.push({ type: 'events', sessionId: SID, events: [runUpdated(4, 'paused')] });
    expect(entry()?.snapshot?.seq).toBe(4);
    expect(entry()?.activity.map((a) => a.label)).toEqual(['Run paused']);
    expect(native.calls.resyncSession).not.toHaveBeenCalled();
  });

  it('F. si la secuencia no se puede seguir, se pide otra foto al lado nativo', () => {
    const native = fakeNative();
    native.push({ type: 'sessions', sessionIds: [SID] });
    native.push({ type: 'snapshot', sessionId: SID, snapshot: snapshotOf() });
    native.push({ type: 'events', sessionId: SID, events: [runUpdated(6, 'paused')] });
    expect(native.calls.resyncSession).toHaveBeenCalledWith(SID);
    expect(entry()?.snapshot?.seq).toBe(3);
  });

  it('los eventos no construyen estado sin una foto de la que partir', () => {
    const native = fakeNative();
    native.push({ type: 'sessions', sessionIds: [SID] });
    native.push({ type: 'events', sessionId: SID, events: [runUpdated(4, 'paused')] });
    expect(entry()?.snapshot).toBeNull();
  });

  it('una foto que no cumple el contrato deja la sesión como ilegible, sin inventar', () => {
    const native = fakeNative();
    native.push({ type: 'sessions', sessionIds: [SID] });
    native.push({ type: 'snapshot', sessionId: SID, snapshot: { seq: 3, session: { id: SID } } });
    expect(entry()).toMatchObject({ snapshot: null, unreadable: true });
    // Y se recupera con la siguiente foto buena.
    native.push({ type: 'snapshot', sessionId: SID, snapshot: snapshotOf() });
    expect(entry()).toMatchObject({ unreadable: false });
    expect(entry()?.snapshot?.seq).toBe(3);
  });

  it('la lista de sesiones sustituye: lo que no está deja de existir', () => {
    const native = fakeNative();
    native.push({ type: 'sessions', sessionIds: [SID, 'ses_b'] });
    native.push({ type: 'snapshot', sessionId: SID, snapshot: snapshotOf() });
    native.push({ type: 'sessions', sessionIds: ['ses_b'] });
    expect(useSessions.getState().order).toEqual(['ses_b']);
    expect(entry()).toBeUndefined();
    // Una foto tardía de la que ya no está no la resucita.
    native.push({ type: 'snapshot', sessionId: SID, snapshot: snapshotOf() });
    expect(entry()).toBeUndefined();
  });

  it('la selección aguanta a que su sesión vuelva (el daemon se reinició)', () => {
    const native = fakeNative();
    native.push({ type: 'sessions', sessionIds: [SID] });
    native.push({ type: 'snapshot', sessionId: SID, snapshot: snapshotOf() });
    useUi.getState().select(SID);
    // Daemon nuevo: de momento no conoce ninguna sesión.
    native.push({ type: 'sessions', sessionIds: [] });
    expect(entry()).toBeUndefined();
    expect(useUi.getState().selectedId).toBe(SID);
    // El anfitrión se vuelve a registrar: la sesión reaparece, ya seleccionada y sin restos.
    native.push({ type: 'sessions', sessionIds: [SID] });
    expect(entry()).toMatchObject({ snapshot: null, activity: [] });
    native.push({ type: 'snapshot', sessionId: SID, snapshot: snapshotOf({ seq: 60 }) });
    expect(entry()?.snapshot?.seq).toBe(60);
    expect(useUi.getState().selectedId).toBe(SID);
  });

  it('una foto con el mismo seq (cambio de foco) no deja marca en la actividad', () => {
    const native = fakeNative();
    native.push({ type: 'sessions', sessionIds: [SID] });
    native.push({ type: 'snapshot', sessionId: SID, snapshot: snapshotOf() });
    native.push({ type: 'snapshot', sessionId: SID, snapshot: snapshotOf() });
    expect(entry()?.activity).toEqual([]);
  });

  it('H. un anfitrión desconectado es «detached», no un fallo', () => {
    const native = fakeNative();
    native.push({ type: 'sessions', sessionIds: [SID] });
    native.push({
      type: 'snapshot',
      sessionId: SID,
      snapshot: snapshotOf({}, { state: 'detached', host: { kind: 'peer', client: 'cli', connected: false } }),
    });
    const snapshot = entry()?.snapshot;
    if (!snapshot) throw new Error('foto');
    expect(displayStatus(snapshot)).toBe('detached');
    // El run se conserva tal cual: no pasa a `failed`.
    expect(snapshot.run?.status).toBe('running');

    // Vuelve su anfitrión: una foto lo dice, y deja de estar detached.
    native.push({ type: 'events', sessionId: SID, events: [stateEvent(4, 'session.updated', { session: sampleSession({ seq: 4 }) })] });
    const back = entry()?.snapshot;
    if (!back) throw new Error('foto');
    expect(displayStatus(back)).toBe('running');
  });
});
