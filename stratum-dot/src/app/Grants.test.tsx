/**
 * M17 — concesiones con caducidad. Qué se ofrece al aprobar (solo si el
 * anfitrión la declara `grantable`, nunca en lo forzado ni con frase), que
 * elegir una duración la pide al lado nativo, y la lista de las vigentes con
 * su botón de revocar. El lado nativo es de mentira: lo que se comprueba es qué
 * pide la interfaz y que lo que enseña sale de la foto.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NativeProvider } from '../bridge/context';
import type { ProtocolApprovalGrant } from '../protocol';
import { activeGrants, approvalChoices, grantMinutesLeft } from '../protocol/interactions';
import { App } from './App';
import {
  CONNECTED,
  CONNECTED_APPROVALS,
  NEW_SID,
  READY,
  SID,
  fakeNative,
  hostedIdle,
  resetStores,
  sampleApproval,
  snapshotOf,
  stateEvent,
  type FakeNative,
} from '../testing/fixtures';

beforeEach(resetStores);
afterEach(cleanup);

const MIN = 60_000;

function grant(overrides: Partial<ProtocolApprovalGrant> = {}): ProtocolApprovalGrant {
  const now = Date.now();
  return {
    id: 'grt_1',
    sessionId: NEW_SID,
    tool: 'exec',
    target: 'prod-db',
    minutes: 30,
    grantedAt: now - 10 * MIN,
    expiresAt: now + 20 * MIN,
    grantedBy: { kind: 'remote', client: 'dot', at: now - 10 * MIN },
    ...overrides,
  };
}

describe('qué concesión se ofrece', () => {
  it('solo si el anfitrión la declara; nunca en lo forzado ni con frase', () => {
    expect(approvalChoices(sampleApproval()).grant).toBe(false);
    expect(approvalChoices(sampleApproval({ grantable: true })).grant).toBe(true);
    expect(approvalChoices(sampleApproval({ grantable: true, forced: true })).grant).toBe(false);
    expect(approvalChoices(sampleApproval({ grantable: true, confirmPhrase: 'prod-db' })).grant).toBe(false);
  });

  it('las vigentes: las caducadas se ocultan, los minutos se redondean hacia arriba', () => {
    const now = 1_000_000_000;
    const snap = hostedIdle({
      grants: [
        grant({ id: 'viva', expiresAt: now + 90_000 }),
        grant({ id: 'caducada', expiresAt: now - 1 }),
        grant({ id: 'de-otra', sessionId: 'ses_otra', expiresAt: now + MIN }),
      ],
    });
    const active = activeGrants(snap, now);
    expect(active.map((g) => g.id)).toEqual(['viva']);
    expect(grantMinutesLeft(active[0]!, now)).toBe(2);
    expect(grantMinutesLeft(grant({ expiresAt: now + 1 }), now)).toBe(1);
    expect(activeGrants(snapshotOf({}), now)).toEqual([]);
  });
});

describe('la tarjeta de aprobación', () => {
  function center(approval = sampleApproval({ id: 'call_g', grantable: true })): FakeNative {
    const native = fakeNative();
    render(
      <NativeProvider value={native}>
        <App />
      </NativeProvider>,
    );
    const snapshot = snapshotOf({ approvals: [approval] }, { id: SID, title: 'Sesión', state: 'waiting' });
    act(() => {
      native.push({ type: 'connection', state: CONNECTED_APPROVALS });
      native.push({ type: 'approver', status: READY });
      native.push({ type: 'sessions', sessionIds: [SID] });
      native.push({ type: 'snapshot', sessionId: SID, snapshot });
    });
    fireEvent.click(screen.getByRole('button', { name: /^Approval Center/ }));
    return native;
  }
  const card = (id: string) => document.querySelector<HTMLElement>(`[data-item="${id}"]`)!;

  it('con `grantable` ofrece 10, 30 y 60 minutos; elegir 30 lo pide al lado nativo', async () => {
    const native = center();
    const c = card('call_g');
    const group = within(c).getByRole('group', { name: 'Allow for a while' });
    expect(within(group).getAllByRole('button').map((b) => b.textContent)).toEqual(['10 min', '30 min', '60 min']);
    await act(async () => fireEvent.click(within(group).getByRole('button', { name: '30 min' })));
    expect(native.calls.approve).toHaveBeenCalledTimes(1);
    expect(native.calls.approve).toHaveBeenCalledWith(SID, 'call_g', { forSession: false, grantMinutes: 30 });
    // Sin optimismo: la tarjeta sigue ahí, esperando a la foto.
    expect(card('call_g').textContent).toContain('Allow for 30 minutes: sent.');
  });

  it('sin `grantable`, forzada o con frase, no hay opción', () => {
    for (const approval of [
      sampleApproval({ id: 'call_n' }),
      sampleApproval({ id: 'call_n', grantable: true, forced: true }),
      sampleApproval({ id: 'call_n', grantable: true, confirmPhrase: 'prod-db' }),
    ]) {
      center(approval);
      expect(within(card('call_n')).queryByRole('group', { name: 'Allow for a while' })).toBeNull();
      cleanup();
      resetStores();
    }
  });
});

describe('las concesiones vigentes de una sesión', () => {
  function chatting(grants: ProtocolApprovalGrant[]): FakeNative {
    const native = fakeNative();
    render(
      <NativeProvider value={native}>
        <App />
      </NativeProvider>,
    );
    act(() => {
      native.push({ type: 'connection', state: CONNECTED });
      native.push({ type: 'sessions', sessionIds: [NEW_SID] });
      native.push({ type: 'snapshot', sessionId: NEW_SID, snapshot: hostedIdle({ grants }) });
    });
    fireEvent.click(screen.getByRole('button', { name: /^Session / }));
    return native;
  }
  const panel = () => document.querySelector<HTMLElement>('[data-grants]');

  it('las enseña con tool, target y minutos que quedan, y oculta la caducada', () => {
    chatting([grant(), grant({ id: 'grt_old', tool: 'write_file', expiresAt: Date.now() - MIN })]);
    const p = panel()!;
    expect(p.textContent).toContain('exec on prod-db');
    expect(p.textContent).toContain('20 min left');
    expect(p.textContent).not.toContain('write_file');
    expect(within(p).getAllByRole('button')).toHaveLength(1);
  });

  it('sin concesiones no pinta nada', () => {
    chatting([]);
    expect(panel()).toBeNull();
  });

  it('revocar llama al método con la sesión y el id, y no quita la fila hasta que la foto lo diga', async () => {
    const native = chatting([grant()]);
    await act(async () => fireEvent.click(within(panel()!).getByRole('button', { name: /^Revoke/ })));
    expect(native.calls.grantsRevoke).toHaveBeenCalledTimes(1);
    expect(native.calls.grantsRevoke).toHaveBeenCalledWith(NEW_SID, 'grt_1');
    expect(panel()!.textContent).toContain('exec on prod-db');
    // El daemon lo publica: la fila se va.
    act(() =>
      native.push({
        type: 'events',
        sessionId: NEW_SID,
        events: [stateEvent(4, 'grant.ended', { grantId: 'grt_1', reason: 'revoked' }, NEW_SID)],
      }),
    );
    await waitFor(() => expect(panel()).toBeNull());
  });

  it('un error al revocar se enseña, y la concesión sigue donde la foto la deja', async () => {
    const native = chatting([grant()]);
    native.calls.grantsRevoke.mockRejectedValueOnce({
      kind: 'rejected',
      code: 'FORBIDDEN',
      reason: null,
      message: 'This client is not allowed to control runs.',
    });
    await act(async () => fireEvent.click(within(panel()!).getByRole('button', { name: /^Revoke/ })));
    expect(within(panel()!).getByRole('alert').textContent).toContain('not allowed');
    expect(panel()!.textContent).toContain('exec on prod-db');
  });

  it('sin respuesta: resultado desconocido, no se reenvía y se pide una foto', async () => {
    const native = chatting([grant()]);
    native.calls.grantsRevoke.mockRejectedValueOnce({ kind: 'unknown', message: 'x' });
    await act(async () => fireEvent.click(within(panel()!).getByRole('button', { name: /^Revoke/ })));
    expect(within(panel()!).getByRole('alert').textContent).toContain('Result unknown');
    expect(native.calls.grantsRevoke).toHaveBeenCalledTimes(1);
    expect(native.calls.resyncSession).toHaveBeenCalledWith(NEW_SID);
  });
});
