import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ConnectionIndicator, describeConnection } from './ConnectionIndicator';
import { initialSidecarState, type SidecarState } from '../../hooks/useSidecar';

const base: SidecarState = initialSidecarState;

describe('ConnectionIndicator', () => {
  it.each<[SidecarState['status'], string]>([
    [{ state: 'starting' }, 'Iniciando agente…'],
    [{ state: 'disconnected', reason: 'x', exitCode: 1 }, 'Agente desconectado'],
    [{ state: 'failed', message: 'x' }, 'Agente no disponible'],
  ])('%j → %s', (status, label) => {
    expect(describeConnection({ ...base, status }).label).toBe(label);
  });

  it('anuncia «Agente conectado» con la latencia del último ping', () => {
    const state: SidecarState = {
      ...base,
      latencyMs: 3.25,
      status: {
        state: 'connected',
        natives: [],
        core: {
          version: '0.4.0',
          protocolVersion: 1,
          configSchemaVersion: 1,
          sessionSchemaVersion: 1,
          platform: 'win32',
          node: '22.20.0',
          sea: true,
        },
      },
    };
    render(<ConnectionIndicator state={state} />);
    const status = screen.getByRole('status');
    expect(status.textContent).toContain('Agente conectado');
    expect(status.textContent).toContain('3.3 ms');
    expect(status.dataset.tone).toBe('ok');
  });
});
