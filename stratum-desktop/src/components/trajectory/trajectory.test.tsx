import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { applyRecords, emptyTrace } from '../../../../stratum-cli/src/trace/model';
import type { TraceRecord } from '../../../../stratum-cli/src/trace/records';
import { traceRecords } from '../../ipc/validate';
import { StatusBar } from '../layout/StatusBar';
import { initialSidecarState } from '../../hooks/useSidecar';
import { TrajectoryPanel } from './TrajectoryPanel';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), Channel: class {} }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));

afterEach(cleanup);

const RECORDS: TraceRecord[] = [
  { t: 'point', at: 1000, id: 'p1', kind: 'system', name: 'Prompt inicial del sistema', data: { content: 'You are Stratum.' } },
  { t: 'turn', at: 1000, input: 'lee a.txt' },
  { t: 'begin', at: 1010, id: 'm1', kind: 'model', name: 'qwen', data: { provider: 'litellm' } },
  { t: 'mark', at: 1100, id: 'm1', name: 'first_token' },
  { t: 'begin', at: 1200, id: 't1', kind: 'tool', name: 'read_file', data: { input: { path: 'a.txt' } } },
  {
    t: 'end',
    at: 1210,
    id: 'm1',
    status: 'ok',
    data: {
      reasoning: 'Voy a leerlo.',
      toolCalls: [{ id: 'c1', name: 'read_file', arguments: '{"path":"a.txt"}' }],
      usage: { promptTokens: 900, completionTokens: 22, totalTokens: 922 },
    },
  },
  { t: 'end', at: 1260, id: 't1', status: 'error', data: { error: 'No existe a.txt', recoverable: true } },
];

const trajectory = (records: TraceRecord[], loaded = true) => ({
  model: applyRecords(emptyTrace(), records),
  loaded,
});

describe('TrajectoryPanel', () => {
  it('pinta un paso por fila y un bloque por paso en su carril', () => {
    const { container } = render(<TrajectoryPanel trajectory={trajectory(RECORDS)} onClose={() => {}} />);
    const rows = container.querySelectorAll('.trajectory__row');
    expect(rows).toHaveLength(4);
    expect(rows[1].textContent).toContain('#1');
    expect(rows[1].textContent).toContain('lee a.txt');
    expect(rows[3].textContent).toContain('read_file {"path":"a.txt"}');
    expect(rows[3].textContent).toContain('→ No existe a.txt');
    expect(rows[3].getAttribute('data-error')).not.toBeNull();

    const lanes = container.querySelectorAll('.trajectory__lane');
    expect(lanes[0].querySelectorAll('.trajectory__block')).toHaveLength(2);
    expect(lanes[1].querySelectorAll('.trajectory__block')).toHaveLength(1);
    expect(lanes[2].querySelectorAll('.trajectory__block')).toHaveLength(1);
    expect(screen.getByText('1 turnos · 4 pasos')).toBeTruthy();
    expect(screen.getByText('922 tok')).toBeTruthy();
  });

  it('elegir un paso abre su detalle con resumen, vista previa y crudo', () => {
    const { container } = render(<TrajectoryPanel trajectory={trajectory(RECORDS)} onClose={() => {}} />);
    expect(screen.queryByLabelText('Detalle del paso')).toBeNull();

    fireEvent.click(container.querySelectorAll('.trajectory__row')[2]);
    const detail = within(screen.getByLabelText('Detalle del paso'));
    expect(detail.getByText('MODELO')).toBeTruthy();
    expect(detail.getByText('Turno 1 · Paso 3')).toBeTruthy();
    expect(detail.getByText('litellm')).toBeTruthy();
    expect(detail.getByText('90 ms')).toBeTruthy(); // primer token
    expect(detail.getByText('900')).toBeTruthy();

    fireEvent.click(detail.getByRole('tab', { name: 'Vista previa' }));
    expect(detail.getByText('Voy a leerlo.')).toBeTruthy();
    expect(detail.getByText('Llamada · read_file')).toBeTruthy();

    fireEvent.click(detail.getByRole('tab', { name: 'Sin procesar' }));
    expect(detail.getByRole('tabpanel').textContent).toContain('"firstToken": 1100');

    fireEvent.click(detail.getByLabelText('Cerrar detalle'));
    expect(screen.queryByLabelText('Detalle del paso')).toBeNull();
  });

  it('un bloque del timeline selecciona el mismo paso que su fila', () => {
    const { container } = render(<TrajectoryPanel trajectory={trajectory(RECORDS)} onClose={() => {}} />);
    fireEvent.click(container.querySelector('.trajectory__block[data-kind="tool"]')!);
    expect(within(screen.getByLabelText('Detalle del paso')).getByText('HERRAMIENTA')).toBeTruthy();
    expect(container.querySelectorAll('.trajectory__row')[3].getAttribute('data-selected')).not.toBeNull();
  });

  it('la búsqueda filtra la lista y el contenido se pinta como texto, nunca como HTML', () => {
    const evil: TraceRecord[] = [
      { t: 'turn', at: 1, input: '<img src=x onerror=alert(1)>' },
      { t: 'point', at: 2, id: 'n1', kind: 'notice', name: 'aviso de contexto' },
    ];
    const { container } = render(<TrajectoryPanel trajectory={trajectory(evil)} onClose={() => {}} />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelectorAll('.trajectory__row')).toHaveLength(2);
    fireEvent.change(screen.getByLabelText('Buscar en la trayectoria'), { target: { value: 'AVISO' } });
    expect(container.querySelectorAll('.trajectory__row')).toHaveLength(1);
  });

  it('distingue «cargando» de «sin pasos» y se cierra con su botón', () => {
    const onClose = vi.fn();
    const { rerender } = render(<TrajectoryPanel trajectory={trajectory([], false)} onClose={onClose} />);
    expect(screen.getByText('Cargando la trayectoria…')).toBeTruthy();
    rerender(<TrajectoryPanel trajectory={trajectory([])} onClose={onClose} />);
    expect(screen.getByText('Todavía no hay pasos en esta conversación.')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Ocultar trayectoria'));
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe('trayectoria: validación y toggle', () => {
  it('traceRecords descarta lo que no encaja y conserva lo válido', () => {
    const out = traceRecords([
      { t: 'turn', at: 1, input: 'hola' },
      { t: 'begin', at: 2, id: 'a', kind: 'model', name: 'm', data: { x: 1 }, extra: true },
      { t: 'begin', at: 2, id: 'b', kind: 'nope', name: 'm' },
      { t: 'end', at: 3, id: 'a', status: 'weird' },
      { t: 'end', at: 3, id: 'a', status: 'ok' },
      { t: 'meta', at: 0, v: 1, sessionId: 's' },
      'basura',
    ]);
    expect(out).toEqual([
      { t: 'turn', at: 1, input: 'hola' },
      { t: 'begin', at: 2, id: 'a', kind: 'model', name: 'm', data: { x: 1 } },
      { t: 'end', at: 3, id: 'a', status: 'ok' },
    ]);
    expect(traceRecords('no')).toBeNull();
  });

  it('el botón de la barra de estado refleja y conmuta el panel', () => {
    const onToggle = vi.fn();
    render(
      <StatusBar
        sidecar={initialSidecarState}
        stats={null}
        workspace={null}
        generating={0}
        queued={0}
        trajectoryOpen
        onToggleTrajectory={onToggle}
      />,
    );
    const button = screen.getByRole('button', { name: 'Trayectoria' });
    expect(button.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(button);
    expect(onToggle).toHaveBeenCalledOnce();
  });
});
