import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ConnectionBanner, ConnectionIndicator, describeConnection } from './ConnectionIndicator';
import type { ConnectionState } from '../../ipc/native';

afterEach(cleanup);

const connected: ConnectionState = {
  kind: 'connected',
  serverVersion: '0.9.0',
  serverPlatform: 'linux',
  protocol: 1,
  capabilities: ['observe', 'control'],
  features: [],
};

describe('estado de la conexión con stratumd (M12)', () => {
  it('cada estado del enlace tiene su texto y su tono', () => {
    expect(describeConnection({ kind: 'starting' }).tone).toBe('pending');
    expect(describeConnection({ kind: 'daemon-starting' }).label).toMatch(/Arrancando/);
    expect(describeConnection(connected)).toEqual({ label: 'Conectado a Stratum', tone: 'ok' });
    expect(describeConnection({ kind: 'reconnecting', attempt: 2 }).tone).toBe('warn');
    expect(describeConnection({ kind: 'error', message: 'x' }).tone).toBe('error');
    expect(
      describeConnection({ kind: 'incompatible', clientProtocol: 1, daemonProtocol: 2, daemonVersion: null }).tone,
    ).toBe('error');
  });

  it('el indicador lo anuncia a un lector de pantalla', () => {
    render(<ConnectionIndicator state={connected} />);
    expect(screen.getByRole('status').textContent).toContain('Conectado a Stratum');
  });

  it('el aviso no aparece conectado; reconectando no ofrece reintentar; sin daemon, sí', () => {
    const onRetry = vi.fn();
    const { container, rerender } = render(<ConnectionBanner state={connected} onRetry={onRetry} />);
    expect(container.textContent).toBe('');
    rerender(<ConnectionBanner state={{ kind: 'reconnecting', attempt: 1 }} onRetry={onRetry} />);
    expect(screen.getByRole('alert').textContent).toMatch(/Reconectando/);
    expect(screen.queryByRole('button', { name: 'Reintentar' })).toBeNull();
    rerender(<ConnectionBanner state={{ kind: 'error', message: 'No hay daemon.' }} onRetry={onRetry} />);
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
