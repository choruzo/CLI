import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NativeProvider } from '../bridge/context';
import { Transcript } from '../components/Transcript';
import { TelegramPanel } from '../components/TelegramPanel';
import type { ApproverStatus } from '../bridge/native';
import { useApprover } from '../stores/approverStore';
import { CONNECTED, TELEGRAM_OFF, fakeNative, hostedIdle, resetStores, type FakeNative } from '../testing/fixtures';

/**
 * M18 — el canal de Telegram en Dot (PRD §23.11): el panel enseña lo que dice
 * `channels.status`; emparejar va en dos pasos (código → candidato) y el último
 * pasa por la confirmación nativa con la autoridad de aprobar; desemparejar
 * solo resta; y en la conversación, la marca «From Telegram».
 */

beforeEach(resetStores);
afterEach(cleanup);

const running = (over: Record<string, unknown> = {}) => ({
  telegram: {
    ...TELEGRAM_OFF,
    state: 'running',
    bot: { id: 7, username: 'mi_dot_bot' },
    ...over,
  },
});
const ana = { userId: 42, name: 'Ana', username: 'ana', pairedAt: 1 };

function mounted(native: FakeNative) {
  render(
    <NativeProvider value={native}>
      <TelegramPanel connected canControl pollMs={20} />
    </NativeProvider>,
  );
  act(() => native.push({ type: 'connection', state: CONNECTED }));
}

const panel = () => screen.getByRole('region', { name: 'Telegram' });

describe('panel de Telegram', () => {
  it('sin configurar: cómo hacerlo desde la terminal, sin emparejar', async () => {
    const native = fakeNative();
    mounted(native);
    await waitFor(() => expect(panel().textContent).toContain('stratum channels telegram setup'));
    expect(within(panel()).queryByRole('button', { name: 'Pair a chat' })).toBeNull();
  });

  it('escuchando: el bot y los emparejados; desemparejar pide confirmación en la página', async () => {
    const native = fakeNative();
    native.calls.channelsStatus.mockResolvedValue(running({ paired: [ana] }));
    mounted(native);
    await waitFor(() => expect(panel().textContent).toContain('@mi_dot_bot'));
    expect(panel().textContent).toContain('Ana (@ana) · id 42');
    fireEvent.click(within(panel()).getByRole('button', { name: 'Unpair Ana' }));
    expect(native.calls.channelsUnpair).not.toHaveBeenCalled();
    const group = within(panel()).getByRole('group', { name: 'Unpair Ana' });
    fireEvent.click(within(group).getByRole('button', { name: 'Unpair' }));
    await waitFor(() => expect(native.calls.channelsUnpair).toHaveBeenCalledWith(42));
    // Sin optimismo: se vuelve a pedir el estado.
    await waitFor(() => expect(native.calls.channelsStatus.mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  it('emparejar: enseña el enlace, espera al candidato y lo confirma por la vía nativa', async () => {
    const native = fakeNative();
    native.calls.channelsStatus.mockResolvedValue(running());
    useApprover.getState().setStatus({ kind: 'ready', expiresAt: Date.now() + 600_000 } as ApproverStatus);
    mounted(native);
    await waitFor(() => expect(within(panel()).getByRole('button', { name: 'Pair a chat' })).toBeTruthy());
    native.calls.channelsStatus.mockResolvedValue(
      running({ pairing: { expiresAt: Date.now() + 600_000, candidate: null } }),
    );
    fireEvent.click(within(panel()).getByRole('button', { name: 'Pair a chat' }));
    await waitFor(() => expect(panel().textContent).toContain('https://t.me/mi_dot_bot?start=ABCDEFGHJK'));
    expect(panel().textContent).toContain('Waiting for it');
    // Alguien manda el código al bot: el panel lo ve al consultar el estado.
    native.calls.channelsStatus.mockResolvedValue(
      running({
        pairing: { expiresAt: Date.now() + 600_000, candidate: { userId: 9, name: 'Bea', username: 'bea' } },
      }),
    );
    await waitFor(() => expect(panel().textContent).toContain('Bea (@bea) · id 9 sent the code.'));
    fireEvent.click(within(panel()).getByRole('button', { name: 'Pair…' }));
    await waitFor(() => expect(native.calls.channelsPairConfirm).toHaveBeenCalledWith(9));
    await waitFor(() => expect(panel().textContent).toContain('Paired.'));
  });

  it('sin la autoridad de aprobar no se empareja: pide desbloquear', async () => {
    const native = fakeNative();
    native.calls.channelsStatus.mockResolvedValue(
      running({ pairing: { expiresAt: Date.now() + 600_000, candidate: { userId: 9, name: 'Bea' } } }),
    );
    mounted(native);
    await waitFor(() => expect(within(panel()).getByRole('button', { name: 'Pair a chat' })).toBeTruthy());
    fireEvent.click(within(panel()).getByRole('button', { name: 'Pair a chat' }));
    await waitFor(() => expect(panel().textContent).toContain('sent the code'));
    const pair = within(panel()).getByRole('button', { name: 'Pair…' }) as HTMLButtonElement;
    expect(pair.disabled).toBe(true);
    fireEvent.click(within(panel()).getByRole('button', { name: 'Unlock…' }));
    expect(native.calls.unlockApprovals).toHaveBeenCalled();
    expect(native.calls.channelsPairConfirm).not.toHaveBeenCalled();
  });

  it('un emparejamiento sin respuesta es «Result unknown» y no se repite', async () => {
    const native = fakeNative();
    native.calls.channelsStatus.mockResolvedValue(
      running({ pairing: { expiresAt: Date.now() + 600_000, candidate: { userId: 9, name: 'Bea' } } }),
    );
    native.calls.channelsPairConfirm.mockRejectedValue({ kind: 'unknown', code: null, reason: null, message: 'x' });
    useApprover.getState().setStatus({ kind: 'ready', expiresAt: Date.now() + 600_000 } as ApproverStatus);
    mounted(native);
    await waitFor(() => expect(within(panel()).getByRole('button', { name: 'Pair a chat' })).toBeTruthy());
    fireEvent.click(within(panel()).getByRole('button', { name: 'Pair a chat' }));
    await waitFor(() => expect(panel().textContent).toContain('sent the code'));
    fireEvent.click(within(panel()).getByRole('button', { name: 'Pair…' }));
    await waitFor(() => expect(panel().textContent).toContain('Result unknown'));
    expect(native.calls.channelsPairConfirm).toHaveBeenCalledTimes(1);
  });
});

describe('marca en la conversación', () => {
  it('lo que llegó por Telegram lleva «From Telegram»; lo escrito en Dot, no', () => {
    const snapshot = hostedIdle({}, { agent: 'companion' });
    snapshot.messages = [
      { kind: 'user', id: 'm1', runId: 'r1', at: 1, text: 'desde el móvil', via: 'telegram' },
      { kind: 'user', id: 'm2', runId: 'r2', at: 2, text: 'desde Dot' },
    ];
    render(<Transcript snapshot={snapshot} sending={false} empty={null} />);
    const items = document.querySelectorAll('[data-kind="user"]');
    expect(items[0]!.textContent).toContain('From Telegram');
    expect(items[1]!.textContent).not.toContain('From Telegram');
  });
});
