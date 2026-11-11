// @vitest-environment jsdom
/**
 * Paridad del modo código con `chat`: pregunta lateral (`/btw`), pasar a
 * segundo plano (Ctrl+B), elegir desde qué turno deshacer (`/rewind`) y la
 * memoria del proyecto (`/memory`).
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { askSideQuestion, backgroundCommand, type UndoableTurn } from '../../client/code-actions';
import { uiActions, uiStore } from '../../client/ui-store';
import type { NativeBridge } from '../../ipc/native';
import { matchCommands, parseCommand } from '../chat/commands';
import { rewindOptions } from './ChangesPanel';
import { JobsPanel } from './JobsPanel';
import { ProjectMemory } from './ProjectMemory';
import { SideAnswer } from './SideAnswer';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), Channel: class {} }));

afterEach(() => {
  cleanup();
  for (const n of uiStore.get().notices) uiActions.dismiss(n.id);
});

const bridge = (over: Partial<NativeBridge>): NativeBridge => over as unknown as NativeBridge;
const rejected = (code: string, reason?: string) => ({ kind: 'rejected', code, message: 'x', ...(reason ? { reason } : {}) });
const notices = () => uiStore.get().notices.map((n) => `${n.tone}: ${n.text}`);

const turn = (n: number, files: number, at: string): UndoableTurn => ({
  turn: n,
  startedAt: at,
  endedAt: at,
  files: Array.from({ length: Math.min(files, 2) }, (_, i) => ({ path: `f${n}-${i}.ts`, status: 'modified' as const })),
  totalFiles: files,
  skipped: 0,
});

describe('comandos', () => {
  it('/btw pide la pregunta y vale en los dos modos; /bg, /rewind y /memory son de código', () => {
    expect(parseCommand('/btw ¿por qué ese cambio?', 'code')).toEqual({ ok: true, name: 'btw', arg: '¿por qué ese cambio?' });
    expect(parseCommand('/btw ¿y esto?', 'chat')).toMatchObject({ ok: true, name: 'btw' });
    expect(parseCommand('/btw', 'code')).toMatchObject({ ok: false });
    for (const name of ['bg', 'rewind', 'memory'] as const) {
      expect(parseCommand(`/${name}`, 'code')).toEqual({ ok: true, name, arg: '' });
      expect(parseCommand(`/${name}`, 'chat')).toMatchObject({ ok: false });
    }
    expect(matchCommands('/b', 'code')?.map((c) => c.name)).toEqual(['bg', 'btw', 'browser']);
  });
});

describe('pregunta lateral', () => {
  it('devuelve la respuesta, y traduce lo que el daemon rechaza sin repetir la pregunta', async () => {
    const askSession = vi.fn(async () => ({ answer: 'porque fallaba el test', truncated: false }));
    expect(await askSideQuestion(bridge({ askSession }), 'ses_1', '¿por qué?')).toEqual({
      ok: true,
      value: { answer: 'porque fallaba el test', truncated: false },
    });
    expect(askSession).toHaveBeenCalledWith('ses_1', '¿por qué?');

    const fails = async (error: unknown) => {
      const ask = vi.fn(async () => {
        throw error;
      });
      const result = await askSideQuestion(bridge({ askSession: ask }), 'ses_1', 'x');
      expect(ask).toHaveBeenCalledTimes(1);
      return result.ok ? '' : result.message;
    };
    expect(await fails(rejected('BUSY'))).toMatch(/Ya hay una pregunta lateral/);
    expect(await fails(rejected('UNAVAILABLE', 'peer-hosted'))).toMatch(/la aloja una terminal/);
    expect(await fails({ kind: 'unknown', message: 'timeout' })).toMatch(/No se ha vuelto a preguntar/);
    expect(await askSideQuestion(bridge({ askSession: vi.fn(async () => ({ answer: 3 })) }), 's', 'x')).toMatchObject({
      ok: false,
    });
  });

  it('la tarjeta distingue pensando, respuesta y fallo, y se cierra a mano', () => {
    const onClose = vi.fn();
    const base = { sessionId: 's', question: '¿por qué ese cambio?' };
    const { rerender } = render(<SideAnswer side={{ ...base, status: 'pending' }} onClose={onClose} />);
    expect(screen.getByText('¿por qué ese cambio?')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe('Pensando…');
    rerender(<SideAnswer side={{ ...base, status: 'done', answer: 'porque fallaba', truncated: true }} onClose={onClose} />);
    expect(screen.getByText('porque fallaba')).toBeTruthy();
    expect(screen.getByText(/era más larga/)).toBeTruthy();
    rerender(<SideAnswer side={{ ...base, status: 'failed', message: 'No se pudo contestar' }} onClose={onClose} />);
    expect(screen.getByRole('alert').textContent).toBe('No se pudo contestar');
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar la pregunta lateral' }));
    expect(onClose).toHaveBeenCalled();
  });
});

describe('pasar a segundo plano', () => {
  it('avisa de lo que pasó: movido, nada que mover, o por qué no', async () => {
    await backgroundCommand(bridge({ backgroundJobs: vi.fn(async () => ({ moved: 1, errors: [] })) }), 'ses_1');
    await backgroundCommand(bridge({ backgroundJobs: vi.fn(async () => ({ moved: 0, errors: [] })) }), 'ses_1');
    await backgroundCommand(
      bridge({ backgroundJobs: vi.fn(async () => ({ moved: 0, errors: ['límite de jobs'] })) }),
      'ses_1',
    );
    expect(notices()).toEqual([
      'info: El comando sigue en segundo plano; el agente continúa.',
      'info: No hay ningún comando en primer plano que pasar a segundo plano.',
      'warning: No se pudo pasar a segundo plano: límite de jobs',
    ]);
  });

  it('el panel de procesos solo lo ofrece cuando se puede', () => {
    const onBackground = vi.fn();
    const { rerender } = render(<JobsPanel jobs={[]} hasSession />);
    expect(screen.queryByRole('button', { name: 'A segundo plano' })).toBeNull();
    rerender(<JobsPanel jobs={[]} hasSession onBackground={onBackground} />);
    fireEvent.click(screen.getByRole('button', { name: 'A segundo plano' }));
    expect(onBackground).toHaveBeenCalledTimes(1);
  });
});

describe('deshacer desde un turno', () => {
  it('una opción por turno con cambios, la más reciente primero; sin lista, los últimos N', () => {
    const known = [turn(7, 2, '2026-11-11T10:30:00Z'), turn(5, 1, '2026-11-11T10:10:00Z'), turn(2, 4, '2026-11-11T09:00:00Z')];
    const options = rewindOptions(known);
    expect(options.map((o) => o.turns)).toEqual([1, 2, 3]);
    expect(options[0]!.label).toMatch(/^el último turno · .+ · 2 ficheros$/);
    expect(options[1]!.label).toMatch(/^desde el turno de las .+ · 2 turnos$/);
    expect(options[2]!.label).toMatch(/· 3 turnos$/);
    expect(rewindOptions([turn(1, 1, 'x')])[0]!.label).toMatch(/1 fichero$/);
    expect(rewindOptions([])).toEqual([]);
    expect(rewindOptions(null).map((o) => o.label)).toEqual([
      'el último turno',
      'los últimos 2 turnos',
      'los últimos 3 turnos',
      'los últimos 4 turnos',
      'los últimos 5 turnos',
    ]);
    // Nunca más de lo que admite deshacer de una vez.
    expect(rewindOptions(Array.from({ length: 30 }, (_, i) => turn(i, 1, 'x')))).toHaveLength(20);
  });
});

describe('ProjectMemory', () => {
  const decision = (id: string, title: string) => ({
    id,
    title,
    type: 'architecture',
    tags: ['build'],
    importance: 'high',
    timestamp: '2026-11-10T10:00:00Z',
    content: `${title}: el detalle`,
    source: 'agent',
  });

  function panel(over: Partial<NativeBridge> = {}, sessionId = 'ses_1') {
    const native = bridge({
      projectMemoryDecisions: vi.fn(async () => ({ decisions: [decision('d1', 'Usar pnpm'), decision('d2', 'Tests con Vitest')] })),
      projectMemoryDocuments: vi.fn(async () => ({
        project: { content: '# Tienda\nReglas del proyecto', truncated: false },
        global: null,
      })),
      projectMemoryForget: vi.fn(async () => ({ removed: true })),
      ...over,
    });
    const view = render(<ProjectMemory native={native} sessionId={sessionId} connected refreshKey="a" />);
    return { native, ...view };
  }

  it('lista las decisiones del proyecto de la sesión y enseña su STRATUM.md', async () => {
    const { native } = panel();
    expect(await screen.findByText('Usar pnpm')).toBeTruthy();
    expect(native.projectMemoryDecisions).toHaveBeenCalledWith('ses_1', undefined);
    expect(native.projectMemoryDocuments).toHaveBeenCalledWith('ses_1');
    expect(screen.queryByText(/Reglas del proyecto/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Ver STRATUM.md' }));
    const doc = screen.getByRole('group', { name: 'STRATUM.md · Proyecto' });
    expect(within(doc).getByText(/Reglas del proyecto/)).toBeTruthy();
    expect(screen.queryByRole('group', { name: 'STRATUM.md · Global' })).toBeNull();
    fireEvent.click(screen.getByText('Usar pnpm'));
    expect(screen.getByText('Usar pnpm: el detalle')).toBeTruthy();
    expect(screen.getByText('La guardó el agente')).toBeTruthy();
  });

  it('buscar pide la consulta; olvidar se confirma, va a esa sesión y relee la lista', async () => {
    const { native } = panel();
    await screen.findByText('Usar pnpm');
    fireEvent.change(screen.getByLabelText('Buscar en la memoria del proyecto'), { target: { value: ' pnpm ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Buscar' }));
    await waitFor(() => expect(native.projectMemoryDecisions).toHaveBeenLastCalledWith('ses_1', 'pnpm'));

    fireEvent.click(await screen.findByRole('button', { name: 'Olvidar Usar pnpm' }));
    expect(native.projectMemoryForget).not.toHaveBeenCalled();
    const confirm = screen.getByRole('group', { name: 'Olvidar Usar pnpm' });
    const calls = vi.mocked(native.projectMemoryDecisions).mock.calls.length;
    fireEvent.click(within(confirm).getByRole('button', { name: 'Olvidar' }));
    await waitFor(() => expect(native.projectMemoryForget).toHaveBeenCalledWith('ses_1', 'd1'));
    // Sin estado optimista: sigue pintada hasta que el daemon devuelve la lista nueva.
    await waitFor(() => expect(vi.mocked(native.projectMemoryDecisions).mock.calls.length).toBeGreaterThan(calls));
  });

  it('sin STRATUM.md ni decisiones lo dice; un resultado desconocido al olvidar no se repite', async () => {
    const first = panel({
      projectMemoryDecisions: vi.fn(async () => ({ decisions: [] })),
      projectMemoryDocuments: vi.fn(async () => ({ project: null, global: null })),
    });
    expect(await screen.findByText(/aún no ha guardado ninguna decisión/)).toBeTruthy();
    expect(screen.getByText(/no tiene/)).toBeTruthy();
    first.unmount();

    const forget = vi.fn(async () => {
      throw { kind: 'unknown', message: 'timeout' };
    });
    panel({ projectMemoryForget: forget });
    fireEvent.click(await screen.findByRole('button', { name: 'Olvidar Usar pnpm' }));
    fireEvent.click(within(screen.getByRole('group', { name: 'Olvidar Usar pnpm' })).getByRole('button', { name: 'Olvidar' }));
    expect(await screen.findByText(/Resultado desconocido/)).toBeTruthy();
    expect(forget).toHaveBeenCalledTimes(1);
  });

  it('otra sesión es otro proyecto: no arrastra lo de la anterior', async () => {
    const decisions = vi.fn(async (sessionId: string) => ({
      decisions: [decision('d', sessionId === 'ses_1' ? 'De la tienda' : 'Del blog')],
    }));
    const native = bridge({
      projectMemoryDecisions: decisions as unknown as NativeBridge['projectMemoryDecisions'],
      projectMemoryDocuments: vi.fn(async () => ({ project: null, global: null })),
    });
    const { rerender } = render(<ProjectMemory native={native} sessionId="ses_1" connected refreshKey="a" />);
    await screen.findByText('De la tienda');
    rerender(<ProjectMemory native={native} sessionId="ses_2" connected refreshKey="a" />);
    expect(await screen.findByText('Del blog')).toBeTruthy();
    expect(screen.queryByText('De la tienda')).toBeNull();
  });

  it('la sesión de un agente embebido no tiene memoria de proyecto', async () => {
    panel({
      projectMemoryDecisions: vi.fn(async () => {
        throw rejected('UNAVAILABLE', 'embedded-agent');
      }),
    });
    expect(await screen.findByText(/no trabaja sobre un proyecto/)).toBeTruthy();
  });
});
