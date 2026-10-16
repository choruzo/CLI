/**
 * M8 — el centro de aprobaciones de Dot. El lado nativo es de mentira: lo que
 * se comprueba es qué pide la interfaz (y qué no), y que lo que enseña sale de
 * las fotos y sus eventos, nunca de suponer.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NativeProvider } from '../bridge/context';
import type { ProtocolPlanRequest, ProtocolQuestionRequest, ProtocolSessionSnapshot } from '../protocol';
import { useUi } from '../stores/uiStore';
import { App } from './App';
import {
  CONNECTED_APPROVALS,
  LOCKED,
  READY,
  SID,
  fakeNative,
  resetStores,
  sampleApproval,
  snapshotOf,
  stateEvent,
  type FakeNative,
} from '../testing/fixtures';

beforeEach(resetStores);
afterEach(cleanup);

const A = SID;
const B = 'ses_20261015_bbb222';
const C = 'ses_20261015_ccc333';

function question(overrides: Partial<ProtocolQuestionRequest> = {}): ProtocolQuestionRequest {
  return {
    id: 'q_1',
    sessionId: B,
    runId: 'run_1',
    requestedAt: 1_760_000_000_800,
    expiresAt: null,
    questions: [
      { question: '¿Qué base de datos?', options: [{ id: 'o1', label: 'Postgres' }, { id: 'o2', label: 'SQLite' }] },
      { question: '¿Nombre del módulo?' },
      { question: '¿Puerto?', options: [{ id: 'p1', label: '8080' }], allowCustom: true },
    ],
    ...overrides,
  };
}

function plan(overrides: Partial<ProtocolPlanRequest> = {}): ProtocolPlanRequest {
  return {
    id: 'plan_1',
    sessionId: C,
    runId: 'run_1',
    requestedAt: 1_760_000_000_900,
    expiresAt: null,
    plan: {
      summary: 'Migrar la autenticación',
      steps: [
        { id: 's1', title: 'Leer el código actual', status: 'pending' },
        { id: 's2', title: 'Escribir la migración', status: 'pending' },
      ],
    },
    ...overrides,
  };
}

function session(id: string, overrides: Partial<ProtocolSessionSnapshot> = {}, title = `Sesión ${id.slice(-3)}`) {
  return snapshotOf(overrides, { id, title, state: 'waiting' });
}

interface Setup {
  snapshots?: ProtocolSessionSnapshot[];
  ready?: boolean;
}

/** Dot conectado a un daemon con aprobadores, con esas sesiones, y en el centro. */
function center({ snapshots = [session(A, { approvals: [sampleApproval()] })], ready = true }: Setup = {}): FakeNative {
  const native = fakeNative();
  render(
    <NativeProvider value={native}>
      <App />
    </NativeProvider>,
  );
  act(() => {
    native.push({ type: 'connection', state: CONNECTED_APPROVALS });
    native.push({ type: 'approver', status: ready ? READY : LOCKED });
    native.push({ type: 'sessions', sessionIds: snapshots.map((s) => s.session.id) });
    for (const s of snapshots) native.push({ type: 'snapshot', sessionId: s.session.id, snapshot: s });
  });
  fireEvent.click(screen.getByRole('button', { name: /^Approval Center/ }));
  return native;
}

const card = (id: string) => document.querySelector<HTMLElement>(`[data-item="${id}"]`);
const button = (scope: HTMLElement, name: string | RegExp) =>
  within(scope).getByRole('button', { name }) as HTMLButtonElement;

describe('centro de aprobaciones', () => {
  it('A aprobación, B preguntas, C plan: cada una con su sesión, contadas en la cabecera y en la bandeja', () => {
    const native = center({
      snapshots: [
        session(A, { approvals: [sampleApproval()] }),
        session(B, { questions: [question()] }),
        session(C, { plans: [plan()] }),
      ],
    });
    expect(screen.getByRole('button', { name: 'Approval Center: 1 approval · 1 question · 1 plan' })).toBeTruthy();
    expect(native.calls.setAttention).toHaveBeenLastCalledWith({ approvals: 1, questions: 1, plans: 1 });
    expect(card('call_2')!.dataset.session).toBe(A);
    expect(card('q_1')!.dataset.session).toBe(B);
    expect(card('plan_1')!.dataset.session).toBe(C);
    expect(card('call_2')!.textContent).toContain('Sesión 123');
    expect(card('q_1')!.textContent).toContain('Sesión 222');
    // Cada una en su sección.
    expect(within(screen.getByRole('region', { name: /^Approvals/ })).queryByText('¿Qué base de datos?')).toBeNull();
    expect(within(screen.getByRole('region', { name: /^Questions/ })).getByText('¿Qué base de datos?')).toBeTruthy();
  });

  it('nunca aprueba sola: ni al llegar la solicitud, ni al abrir, ni al desbloquear', () => {
    const native = center();
    act(() =>
      native.push({
        type: 'events',
        sessionId: A,
        events: [stateEvent(4, 'approval.requested', { approval: sampleApproval({ id: 'call_9' }) })],
      }),
    );
    act(() => native.push({ type: 'approver', status: READY }));
    for (const call of [native.calls.approve, native.calls.deny, native.calls.answerQuestions, native.calls.decidePlan]) {
      expect(call).not.toHaveBeenCalled();
    }
  });

  it('bloqueado: se ve todo, no se puede resolver, y desbloquear abre la ventana nativa (sin clave aquí)', () => {
    const native = center({ ready: false });
    const c = card('call_2')!;
    expect(c.textContent).toContain('git push origin main');
    expect(button(c, 'Approve').disabled).toBe(true);
    expect(button(c, 'Deny').disabled).toBe(true);
    expect(c.textContent).toContain('Unlock approvals to resolve this from Dot.');
    // Ningún campo de clave en el webview.
    expect(document.querySelector('input[type="password"]')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Unlock approvals' }));
    expect(native.calls.unlockApprovals).toHaveBeenCalledTimes(1);
    expect(native.calls.unlockApprovals.mock.calls[0]).toEqual([]);
  });

  it('sin clave configurada en el daemon: lo dice, con cómo configurarla, y no ofrece desbloquear', () => {
    const native = center({ ready: false });
    act(() => native.push({ type: 'approver', status: { kind: 'unavailable', reason: 'no-approver-key' } }));
    expect(screen.getByText(/stratum approvals set-key/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Unlock approvals' })).toBeNull();
  });

  it('aprobar: una petición, sin optimismo; desaparece cuando la sesión lo publica', () => {
    const native = center();
    const c = card('call_2')!;
    fireEvent.click(button(c, 'Approve'));
    expect(native.calls.approve).toHaveBeenCalledTimes(1);
    expect(native.calls.approve).toHaveBeenCalledWith(A, 'call_2', { forSession: false });
    return Promise.resolve().then(async () => {
      await act(async () => undefined);
      // Aceptada no es aprobada: sigue ahí, esperando a la sesión.
      expect(card('call_2')!.textContent).toMatch(/sent\. Waiting for the session to confirm/);
      expect(button(card('call_2')!, 'Approve').disabled).toBe(true);
      act(() =>
        native.push({
          type: 'events',
          sessionId: A,
          events: [
            stateEvent(4, 'approval.resolved', {
              approvalId: 'call_2',
              status: 'approved',
              decision: 'approve',
              resolvedBy: { kind: 'remote', client: 'dot', connectionId: 7, at: 1 },
            }),
          ],
        }),
      );
      expect(card('call_2')).toBeNull();
      const resolved = screen.getByRole('region', { name: 'Recently resolved' });
      expect(resolved.textContent).toContain('Approved');
      expect(resolved.textContent).toContain('from Stratum Dot');
    });
  });

  it('el foco nunca empieza en Aprobar, Enter en la tarjeta no aprueba y Deny va primero', () => {
    const native = center();
    // Desde el chat, «Open» lleva a la tarjeta.
    act(() => useUi.getState().setView('sessions'));
    fireEvent.click(screen.getByRole('button', { name: /^Session / }));
    fireEvent.click(screen.getByRole('button', { name: /^Open in the Approval Center/ }));
    const c = card('call_2')!;
    expect(document.activeElement).toBe(c);
    fireEvent.keyDown(c, { key: 'Enter' });
    expect(native.calls.approve).not.toHaveBeenCalled();
    const names = within(c)
      .getAllByRole('button')
      .map((b) => b.textContent);
    expect(names.indexOf('Deny')).toBeLessThan(names.indexOf('Approve'));
  });

  it('Esc cierra el centro y nunca deniega', () => {
    const native = center();
    (document.activeElement as HTMLElement | null)?.blur();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(native.calls.deny).not.toHaveBeenCalled();
    expect(screen.queryByRole('region', { name: 'Approval Center' })).toBeNull();
    fireEvent.keyDown(window, { key: 'A', ctrlKey: true, shiftKey: true });
    expect(screen.getByRole('region', { name: 'Approval Center' })).toBeTruthy();
    expect(native.calls.approve).not.toHaveBeenCalled();
  });

  it('con frase: se teclea en la ventana nativa, no aquí, y no se ofrece «para la sesión»', async () => {
    const native = center({
      snapshots: [session(A, { approvals: [sampleApproval({ confirmPhrase: 'prod-db', target: 'ssh:prod-db' })] })],
    });
    const c = card('call_2')!;
    expect(c.className).toContain('danger');
    expect(c.textContent).toContain('Needs its confirmation phrase');
    // El webview no tiene dónde teclearla ni la envía: la pide la ventana nativa.
    expect(within(c).queryByRole('textbox')).toBeNull();
    expect(c.querySelector('[data-phrase]')!.textContent).toContain('prod-db');
    expect(within(c).queryByRole('button', { name: 'Allow for this session' })).toBeNull();
    // El daemon dice que no (la frase de verdad era otra): no se aprueba nada.
    native.calls.approve.mockRejectedValueOnce({ kind: 'rejected', code: 'INVALID_PARAMS', reason: null, message: 'x' });
    await act(async () => fireEvent.click(button(c, 'Approve')));
    expect(native.calls.approve).toHaveBeenCalledWith(A, 'call_2', { forSession: false });
    expect(card('call_2')!.textContent).toContain('The confirmation phrase does not match. Nothing was approved.');
    // Sigue pendiente y se puede volver a intentar a mano.
    expect(button(card('call_2')!, 'Approve').disabled).toBe(false);
    expect(native.calls.approve).toHaveBeenCalledTimes(1);
  });

  it('forzada: sin «para la sesión»; si no, «para la sesión» dice que es solo esa sesión', async () => {
    center({
      snapshots: [
        session(A, { approvals: [sampleApproval({ forced: true })] }),
        session(B, { approvals: [sampleApproval({ id: 'call_b', sessionId: B })] }),
      ],
    });
    const forced = card('call_2')!;
    expect(forced.textContent).toContain('Required by policy');
    expect(within(forced).queryByRole('button', { name: 'Allow for this session' })).toBeNull();
    const plain = card('call_b')!;
    const allow = button(plain, 'Allow for this session');
    expect(plain.textContent).toMatch(/this session only\. It does not change any\s+configuration/);
    await act(async () => fireEvent.click(allow));
  });

  it('«para la sesión» envía allow-all solo para la sesión de esa solicitud', async () => {
    const native = center({ snapshots: [session(B, { approvals: [sampleApproval({ id: 'call_b', sessionId: B })] })] });
    await act(async () => fireEvent.click(button(card('call_b')!, 'Allow for this session')));
    expect(native.calls.approve).toHaveBeenCalledWith(B, 'call_b', { forSession: true });
  });

  it('otro llegó antes: «ya resuelta en otro sitio», se pide una foto y converge', async () => {
    const native = center();
    native.calls.approve.mockRejectedValueOnce({
      kind: 'rejected',
      code: 'ALREADY_RESOLVED',
      reason: null,
      message: 'That request was already resolved.',
    });
    await act(async () => fireEvent.click(button(card('call_2')!, 'Approve')));
    expect(card('call_2')!.textContent).toContain('Already resolved elsewhere');
    expect(native.calls.resyncSession).toHaveBeenCalledWith(A);
    // La foto nueva ya no la trae: desaparece, sin que Dot lo decida.
    act(() => native.push({ type: 'snapshot', sessionId: A, snapshot: session(A, { seq: 5 }) }));
    expect(card('call_2')).toBeNull();
    expect(native.calls.approve).toHaveBeenCalledTimes(1);
  });

  it('resultado desconocido: se dice, se pide una foto y no se reenvía', async () => {
    const native = center();
    native.calls.deny.mockRejectedValueOnce({ kind: 'unknown', code: null, reason: null, message: 'lost' });
    await act(async () => fireEvent.click(button(card('call_2')!, 'Deny')));
    expect(card('call_2')!.textContent).toContain('Result unknown');
    expect(card('call_2')!.textContent).toContain('It was not sent again');
    expect(native.calls.deny).toHaveBeenCalledTimes(1);
    expect(native.calls.resyncSession).toHaveBeenCalledWith(A);
  });

  it('caducada o cancelada mientras se mira: desaparece con su motivo y ya no hay botones', () => {
    const native = center({
      snapshots: [
        session(A, { approvals: [sampleApproval({ expiresAt: 1_760_000_600_700 })] }),
        session(B, { approvals: [sampleApproval({ id: 'call_b', sessionId: B })] }),
      ],
    });
    expect(card('call_2')!.textContent).toMatch(/Expires in|Expiring/);
    act(() => {
      native.push({
        type: 'events',
        sessionId: A,
        events: [stateEvent(4, 'approval.resolved', { approvalId: 'call_2', status: 'expired', decision: 'deny', resolvedBy: { kind: 'timeout', at: 1 } })],
      });
      native.push({
        type: 'events',
        sessionId: B,
        events: [stateEvent(4, 'approval.resolved', { approvalId: 'call_b', status: 'cancelled' }, B)],
      });
    });
    expect(card('call_2')).toBeNull();
    expect(card('call_b')).toBeNull();
    const resolved = screen.getByRole('region', { name: 'Recently resolved' });
    expect(resolved.textContent).toContain('Expired');
    expect(resolved.textContent).toContain('nobody answered in time');
    expect(resolved.textContent).toContain('Cancelled');
    expect(within(resolved).queryByRole('button', { name: /approve|deny/i })).toBeNull();
  });

  it('aprobar no reanuda: con el run en pausa se dice, y no se pide `resume`', () => {
    const native = center({ snapshots: [session(A, { approvals: [sampleApproval()] }, 'En pausa')] });
    act(() =>
      native.push({
        type: 'snapshot',
        sessionId: A,
        snapshot: snapshotOf({ approvals: [sampleApproval()], seq: 4 }, { id: A, state: 'waiting' }, { status: 'paused' }),
      }),
    );
    expect(card('call_2')!.textContent).toContain('Resolving this does not resume it.');
    fireEvent.click(button(card('call_2')!, 'Approve'));
    act(() =>
      native.push({
        type: 'events',
        sessionId: A,
        events: [
          stateEvent(5, 'approval.resolved', {
            approvalId: 'call_2',
            status: 'approved',
            decision: 'approve',
            resolvedBy: { kind: 'remote', client: 'dot', connectionId: 7, at: 1 },
          }),
        ],
      }),
    );
    expect(screen.getByText(/Approved\. The run remains paused: resume it to continue\./)).toBeTruthy();
    expect(native.calls.resumeRun).not.toHaveBeenCalled();
  });

  it('si cae la conexión de aprobador, lo pendiente sigue a la vista y no se puede resolver', () => {
    const native = center();
    act(() => native.push({ type: 'approver', status: { kind: 'locked', reason: 'connection-lost' } }));
    expect(screen.getByText(/The approval connection was lost/)).toBeTruthy();
    expect(card('call_2')).toBeTruthy();
    expect(button(card('call_2')!, 'Approve').disabled).toBe(true);
    // La conexión principal sigue: se sigue viendo y controlando.
    expect(screen.getByText('Connected')).toBeTruthy();
  });

  it('tras reconectar, lo que se resolvió en otro sitio ya no aparece', () => {
    const native = center();
    act(() => native.push({ type: 'connection', state: { kind: 'reconnecting', attempt: 1 } }));
    expect(button(card('call_2')!, 'Approve').disabled).toBe(true);
    act(() => {
      native.push({ type: 'connection', state: CONNECTED_APPROVALS });
      native.push({ type: 'snapshot', sessionId: A, snapshot: session(A, { seq: 9 }) });
    });
    expect(card('call_2')).toBeNull();
    expect(screen.getByText('No approvals waiting.')).toBeTruthy();
  });

  it('una sesión sin anfitrión: se ve, pero solo se puede resolver en su terminal', () => {
    center({
      snapshots: [
        snapshotOf(
          { approvals: [sampleApproval({ resolvable: 'origin' })] },
          { id: A, state: 'detached', host: { kind: 'peer', client: 'cli', connected: false } },
        ),
      ],
    });
    const c = card('call_2')!;
    expect(c.textContent).toContain('can only be resolved in its terminal');
    expect(button(c, 'Approve').disabled).toBe(true);
    expect(button(c, 'Deny').disabled).toBe(true);
  });

  it('preguntas: opción, texto propio y «otra», canonizadas con la regla del contrato; omitir manda null', async () => {
    const native = center({ snapshots: [session(B, { questions: [question()] })] });
    const c = card('q_1')!;
    const send = button(c, 'Send answers');
    expect(send.disabled).toBe(true);
    fireEvent.click(within(c).getByRole('radio', { name: 'Postgres' }));
    fireEvent.change(within(c).getByRole('textbox', { name: 'Answer to: ¿Nombre del módulo?' }), {
      target: { value: 'auth' },
    });
    expect(send.disabled).toBe(true);
    fireEvent.click(within(c).getByRole('radio', { name: 'Other answer' }));
    fireEvent.change(within(c).getByRole('textbox', { name: 'Other answer to: ¿Puerto?' }), { target: { value: '9000' } });
    expect(send.disabled).toBe(false);
    await act(async () => fireEvent.click(send));
    expect(native.calls.answerQuestions).toHaveBeenCalledWith(B, 'q_1', [
      { question: '¿Qué base de datos?', answer: 'Postgres', optionId: 'o1' },
      { question: '¿Nombre del módulo?', answer: 'auth' },
      { question: '¿Puerto?', answer: '9000' },
    ]);
    // Responder no es un mensaje nuevo ni steering.
    expect(native.calls.startRun).not.toHaveBeenCalled();
    expect(native.calls.steerRun).not.toHaveBeenCalled();
  });

  it('preguntas: omitir la tanda', async () => {
    const native = center({ snapshots: [session(B, { questions: [question()] })] });
    await act(async () => fireEvent.click(button(card('q_1')!, 'Skip questions')));
    expect(native.calls.answerQuestions).toHaveBeenCalledWith(B, 'q_1', null);
  });

  it('plan: aprobar o rechazar el propuesto, sin abrir otro run', async () => {
    const native = center({ snapshots: [session(C, { plans: [plan()] })] });
    const c = card('plan_1')!;
    expect(c.textContent).toContain('Migrar la autenticación');
    expect(within(c).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'Leer el código actual',
      'Escribir la migración',
    ]);
    await act(async () => fireEvent.click(button(c, 'Reject plan')));
    expect(native.calls.decidePlan).toHaveBeenCalledWith(C, 'plan_1', 'reject');
    expect(native.calls.startRun).not.toHaveBeenCalled();
    expect(native.calls.steerRun).not.toHaveBeenCalled();
  });

  it('el orden es determinista: lo más antiguo primero', () => {
    center({
      snapshots: [
        session(A, {
          approvals: [
            sampleApproval({ id: 'late', requestedAt: 300 }),
            sampleApproval({ id: 'early', requestedAt: 100 }),
          ],
        }),
        session(B, { approvals: [sampleApproval({ id: 'mid', sessionId: B, requestedAt: 200 })] }),
      ],
    });
    const ids = [...document.querySelectorAll<HTMLElement>('[data-kind="approval"][data-item]')].map((el) => el.dataset.item);
    expect(ids).toEqual(['early', 'mid', 'late']);
  });
});

describe('confirmación nativa (M9)', () => {
  it('mientras la ventana nativa está abierta, la tarjeta lo dice y no deja pedir otra cosa', async () => {
    const native = center();
    let finish: (() => void) | undefined;
    native.calls.approve.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    await act(async () => fireEvent.click(button(card('call_2')!, 'Approve')));
    expect(card('call_2')!.textContent).toContain('Approve: confirm it in the Stratum Dot confirmation window');
    expect(button(card('call_2')!, 'Deny').disabled).toBe(true);
    await act(async () => finish!());
    expect(card('call_2')!.textContent).toContain('Approve: sent');
  });

  it('cancelar en la ventana no es un error: no salió nada y la tarjeta vuelve a estar como antes', async () => {
    const native = center();
    native.calls.approve.mockRejectedValueOnce({
      kind: 'not-confirmed',
      code: null,
      reason: 'cancelled',
      message: 'Not confirmed. Nothing was sent.',
    });
    await act(async () => fireEvent.click(button(card('call_2')!, 'Approve')));
    const c = card('call_2')!;
    expect(c.querySelector('[role="alert"]')).toBeNull();
    expect(c.textContent).not.toContain('Not confirmed');
    expect(button(c, 'Approve').disabled).toBe(false);
    expect(native.calls.resyncSession).not.toHaveBeenCalled();
  });

  it('resuelta en otro sitio con la ventana abierta: se dice y se pide una foto, sin reenviar', async () => {
    const native = center();
    native.calls.approve.mockRejectedValueOnce({
      kind: 'not-confirmed',
      code: null,
      reason: 'resolved-elsewhere',
      message: 'The request was resolved elsewhere before you confirmed. Nothing was sent.',
    });
    await act(async () => fireEvent.click(button(card('call_2')!, 'Approve')));
    expect(card('call_2')!.textContent).toContain('resolved elsewhere before you confirmed');
    expect(native.calls.resyncSession).toHaveBeenCalledWith(A);
    expect(native.calls.approve).toHaveBeenCalledTimes(1);
  });

  it('denegar, omitir y rechazar no piden confirmación; aprobar, responder y aprobar el plan sí', async () => {
    const native = center({
      snapshots: [
        session(A, { approvals: [sampleApproval()] }),
        session(B, { questions: [question({ questions: [{ question: '¿Puerto?' }] })] }),
        session(C, { plans: [plan()] }),
      ],
    });
    await act(async () => fireEvent.click(button(card('plan_1')!, 'Approve plan')));
    expect(card('plan_1')!.textContent).toContain('Approve plan: sent');
    const q = card('q_1')!;
    fireEvent.change(within(q).getByRole('textbox'), { target: { value: '8080' } });
    native.calls.answerQuestions.mockImplementationOnce(() => new Promise<void>(() => undefined));
    await act(async () => fireEvent.click(button(q, 'Send answers')));
    expect(card('q_1')!.textContent).toContain('confirm it in the Stratum Dot confirmation window');
    await act(async () => fireEvent.click(button(card('call_2')!, 'Deny')));
    expect(card('call_2')!.textContent).not.toContain('confirmation window…');
  });
});
