import { describe, expect, it } from 'vitest';
import { applySessionEvent, type ProtocolEvent } from './index';
import { applyEvents, parseEvent, parseSnapshot } from './apply';
import { composerMode, hostLabel } from './view';
import { delta, runUpdated, sampleToolCall, snapshotOf, stateEvent } from '../testing/fixtures';

describe('validación', () => {
  it('una foto del contrato pasa, y solo con los campos del contrato', () => {
    const raw = { ...snapshotOf(), secreto: 'no-es-del-contrato', env: { TOKEN: 'x' } };
    const parsed = parseSnapshot(raw);
    expect(parsed).not.toBeNull();
    expect(parsed).not.toHaveProperty('secreto');
    expect(parsed).not.toHaveProperty('env');
    expect(parsed?.seq).toBe(3);
  });

  it('una foto que no cumple el contrato no se pinta', () => {
    expect(parseSnapshot({ seq: 3 })).toBeNull();
    expect(parseSnapshot({ ...snapshotOf(), run: { status: 'pause-requested' } })).toBeNull();
    expect(parseSnapshot(null)).toBeNull();
  });

  it('un evento desconocido con seq cuenta en la secuencia; uno roto, no', () => {
    expect(parseEvent(stateEvent(4, 'future.thing', { x: 1 }))).toEqual({
      kind: 'unknown-state',
      sessionId: 'ses_20261012_abc123',
      seq: 4,
      at: 1_760_000_002_004,
    });
    expect(parseEvent({ type: 'future.delta', sessionId: 's', after: 4, data: {} })).toEqual({ kind: 'skip' });
    // Tipo conocido con datos que no validan: no se adivina.
    expect(parseEvent(stateEvent(4, 'run.updated', { run: {} }))).toEqual({ kind: 'invalid' });
    expect(parseEvent('nope')).toEqual({ kind: 'invalid' });
  });
});

describe('applyEvents: el reductor del contrato, y cuándo pedir foto', () => {
  it('E. el evento siguiente se aplica con applySessionEvent', () => {
    const before = snapshotOf();
    const raw = runUpdated(4, 'paused');
    const { snapshot, applied, needsResync } = applyEvents(before, [raw]);
    // Lo mismo que daría el reductor del contrato, sin nada propio.
    const parsed = parseEvent(raw);
    if (parsed.kind !== 'event') throw new Error('evento válido');
    expect(snapshot).toEqual(applySessionEvent(before, parsed.event));
    expect(snapshot.seq).toBe(4);
    expect(snapshot.run?.status).toBe('paused');
    expect(applied.map((e: ProtocolEvent) => e.type)).toEqual(['run.updated']);
    expect(needsResync).toBe(false);
    // La foto de entrada no se toca.
    expect(before.seq).toBe(3);
  });

  it('F. un hueco no se remienda: se aplica lo anterior y se pide foto', () => {
    const { snapshot, needsResync } = applyEvents(snapshotOf(), [runUpdated(4, 'paused'), runUpdated(6, 'running')]);
    expect(snapshot.seq).toBe(4);
    expect(snapshot.run?.status).toBe('paused');
    expect(needsResync).toBe(true);
  });

  it('un evento repetido se ignora sin pedir nada', () => {
    const { snapshot, needsResync } = applyEvents(snapshotOf(), [runUpdated(3, 'paused'), runUpdated(2, 'paused')]);
    expect(snapshot.seq).toBe(3);
    expect(snapshot.run?.status).toBe('running');
    expect(needsResync).toBe(false);
  });

  it('G. los fragmentos se pueden perder: message.completed y la foto mandan', () => {
    const start = snapshotOf();
    // Llegan «Ho» y «mundo»; «la » se perdió por el camino.
    const partial = applyEvents(start, [delta(3, 'Ho'), delta(3, 'mundo')]);
    expect(partial.snapshot.partial.text).toBe('Homundo');
    expect(partial.needsResync).toBe(false);
    // El bloque se cierra con el texto entero: lo parcial deja de contar.
    const closed = applyEvents(partial.snapshot, [stateEvent(4, 'message.completed', { text: 'Hola mundo' })]);
    expect(closed.snapshot.partial.text).toBe('');
    expect(closed.applied).toHaveLength(1);
    // Un fragmento que llega tarde (anterior a la foto) no ensucia nada.
    expect(applyEvents(closed.snapshot, [delta(3, 'tarde')]).snapshot.partial.text).toBe('');
  });

  it('sin ningún fragmento, el estado es el mismo', () => {
    const withDeltas = applyEvents(snapshotOf(), [
      delta(3, 'Hola '),
      delta(3, 'mundo'),
      stateEvent(4, 'message.completed', { text: 'Hola mundo' }),
      stateEvent(5, 'tool.started', { call: sampleToolCall({ state: 'running' }) }),
    ]);
    const without = applyEvents(snapshotOf(), [
      stateEvent(4, 'message.completed', { text: 'Hola mundo' }),
      stateEvent(5, 'tool.started', { call: sampleToolCall({ state: 'running' }) }),
    ]);
    expect(withDeltas.snapshot).toEqual(without.snapshot);
  });

  it('un evento de un tipo futuro avanza la secuencia sin tocar nada más', () => {
    const { snapshot, applied, needsResync } = applyEvents(snapshotOf(), [
      stateEvent(4, 'future.thing', { x: 1 }),
      runUpdated(5, 'paused'),
    ]);
    expect(needsResync).toBe(false);
    expect(snapshot.seq).toBe(5);
    expect(snapshot.session.seq).toBe(5);
    expect(snapshot.run?.status).toBe('paused');
    expect(applied.map((e) => e.type)).toEqual(['run.updated']);
  });

  it('un evento que no valida pide foto y no se aplica a medias', () => {
    const { snapshot, needsResync } = applyEvents(snapshotOf(), [stateEvent(4, 'run.updated', { run: { status: 'x' } })]);
    expect(snapshot.seq).toBe(3);
    expect(needsResync).toBe(true);
  });

  it('eventos de otra sesión no cuentan', () => {
    const { snapshot, needsResync } = applyEvents(snapshotOf(), [stateEvent(9, 'warning', { message: 'x' }, 'ses_otra')]);
    expect(snapshot.seq).toBe(3);
    expect(needsResync).toBe(false);
  });
});

describe('M10: una sesión que pasa de su terminal al daemon', () => {
  it('es la misma sesión: un session.updated cambia el anfitrión, y el campo pasa a preguntar', () => {
    const peer = snapshotOf(
      {},
      { state: 'idle', currentRunId: null, host: { kind: 'peer', client: 'cli', connected: true } },
      null,
    );
    const link = { connected: true, canControl: true };
    expect(composerMode(peer, link).kind).toBe('off');
    expect(hostLabel(peer)).toBe('cli (peer)');

    const session = { ...peer.session, seq: 4, host: { kind: 'daemon', client: 'daemon', connected: true } };
    const { snapshot, needsResync } = applyEvents(peer, [stateEvent(4, 'session.updated', { session })]);
    expect(needsResync).toBe(false);
    expect(snapshot.session.id).toBe(peer.session.id);
    expect(snapshot.seq).toBe(4);
    expect(snapshot.messages).toEqual(peer.messages);
    expect(snapshot.run).toEqual(peer.run);
    expect(hostLabel(snapshot)).toBe('daemon');
    expect(composerMode(snapshot, link)).toEqual({ kind: 'ask' });
  });
});
