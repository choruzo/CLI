// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentProfile, Changes } from '../../client/code-actions';
import type { ProtocolJob } from '../../protocol';
import { diffLines, DiffView } from './ChangesPanel';
import { CodeBar, changesLabel } from './CodeBar';
import { JobsPanel, formatElapsed, sortJobs } from './JobsPanel';
import { ProjectPicker } from './ProjectPicker';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), Channel: class {} }));
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn() }));

afterEach(cleanup);

const profile = (name: string, mode: AgentProfile['mode'] = 'primary'): AgentProfile => ({
  name,
  description: `Perfil ${name}`,
  mode,
  origin: 'builtin',
  allowedTools: null,
});

const changes = (over: Partial<Changes> = {}): Changes => ({
  isRepo: true,
  files: 2,
  added: 12,
  deleted: 3,
  truncated: false,
  changes: [
    { path: 'src/app.ts', added: 10, deleted: 3, status: 'modified' },
    { path: 'README.md', added: 2, deleted: 0, status: 'untracked' },
  ],
  ...over,
});

function bar(over: Partial<Parameters<typeof CodeBar>[0]> = {}) {
  const props = {
    cwd: 'C:\\src\\tienda',
    agent: 'general',
    readOnly: false,
    profiles: [profile('reviewer'), profile('planner')],
    changes: changes(),
    runningJobs: 0,
    locked: false,
    onAgent: vi.fn(),
    onReadOnly: vi.fn(),
    onOpenChanges: vi.fn(),
    onOpenJobs: vi.fn(),
    ...over,
  };
  render(<CodeBar {...props} />);
  return props;
}

describe('CodeBar', () => {
  it('enseña el proyecto, el perfil y el resumen de cambios', () => {
    bar();
    expect(screen.getByText('tienda')).toBeTruthy();
    const select = screen.getByRole('combobox', { name: 'Perfil de agente' }) as HTMLSelectElement;
    expect(select.value).toBe('general');
    expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual(['general', 'reviewer', 'planner']);
    expect(screen.getByRole('button', { name: /2 ficheros/ }).textContent).toContain('+12');
  });

  it('el perfil de la sesión aparece aunque la lista no lo traiga', () => {
    bar({ agent: 'devops', profiles: null });
    const select = screen.getByRole('combobox', { name: 'Perfil de agente' }) as HTMLSelectElement;
    expect(select.value).toBe('devops');
  });

  it('elegir «general» quita el perfil; otro, lo pone', () => {
    const props = bar({ agent: 'reviewer' });
    const select = screen.getByRole('combobox', { name: 'Perfil de agente' });
    fireEvent.change(select, { target: { value: 'general' } });
    expect(props.onAgent).toHaveBeenLastCalledWith(null);
    fireEvent.change(select, { target: { value: 'planner' } });
    expect(props.onAgent).toHaveBeenLastCalledWith('planner');
  });

  it('solo lectura es un interruptor que pide lo contrario de lo que hay', () => {
    const props = bar({ readOnly: true });
    const toggle = screen.getByRole('switch', { name: 'Solo lectura' });
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(toggle);
    expect(props.onReadOnly).toHaveBeenCalledWith(false);
  });

  it('bloqueada: no se reconfigura, pero los cambios se siguen pudiendo ver', () => {
    const props = bar({ locked: true, lockedReason: 'Se podrá cambiar cuando acabe el turno en marcha.' });
    expect((screen.getByRole('combobox', { name: 'Perfil de agente' }) as HTMLSelectElement).disabled).toBe(true);
    expect((screen.getByRole('switch', { name: 'Solo lectura' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: /2 ficheros/ }));
    expect(props.onOpenChanges).toHaveBeenCalledOnce();
  });

  it('con procesos en marcha, un acceso a su panel', () => {
    const props = bar({ runningJobs: 2 });
    fireEvent.click(screen.getByRole('button', { name: /2 en marcha/ }));
    expect(props.onOpenJobs).toHaveBeenCalledOnce();
  });

  it('el resumen dice lo que hay cuando no hay nada que contar', () => {
    expect(changesLabel(null)).toBe('Cambios');
    expect(changesLabel(changes({ isRepo: false, files: 0 }))).toBe('Sin repositorio git');
    expect(changesLabel(changes({ files: 0 }))).toBe('Sin cambios');
    expect(changesLabel(changes({ files: 1 }))).toBe('1 fichero');
  });
});

describe('ProjectPicker', () => {
  const pick = (over: Partial<Parameters<typeof ProjectPicker>[0]> = {}) => {
    const props = {
      project: null,
      recent: ['C:\\src\\tienda', 'C:\\src\\blog'],
      profiles: [profile('reviewer')],
      agent: 'general',
      picking: false,
      disabled: false,
      onPick: vi.fn(),
      onProject: vi.fn(),
      onAgent: vi.fn(),
      ...over,
    };
    render(<ProjectPicker {...props} />);
    return props;
  };

  it('sin carpeta, pide elegirla y propone las recientes', () => {
    const props = pick();
    expect(screen.getByText('Elige la carpeta del proyecto para empezar')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Elegir carpeta…' }));
    expect(props.onPick).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'blog' }));
    expect(props.onProject).toHaveBeenCalledWith('C:\\src\\blog');
  });

  it('con carpeta, la enseña y no la repite entre las recientes', () => {
    pick({ project: 'C:\\src\\tienda' });
    expect(screen.getByText('C:\\src\\tienda')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Cambiar…' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'tienda' })).toBeNull();
    expect(screen.getByRole('button', { name: 'blog' })).toBeTruthy();
  });

  it('mientras el diálogo está abierto no se abre otro', () => {
    pick({ picking: true });
    expect((screen.getByRole('button', { name: 'Eligiendo…' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('JobsPanel', () => {
  const job = (over: Partial<ProtocolJob>): ProtocolJob => ({
    id: 'j1',
    sessionId: 's',
    command: 'npm run dev',
    cwd: '/p',
    status: 'running',
    startedAt: Date.now() - 65_000,
    scope: 'main',
    ...over,
  });

  it('los que siguen en marcha van primero', () => {
    const sorted = sortJobs([
      job({ id: 'a', status: 'completed', startedAt: 300 }),
      job({ id: 'b', status: 'running', startedAt: 100 }),
      job({ id: 'c', status: 'failed', startedAt: 200 }),
    ]);
    expect(sorted.map((j) => j.id)).toEqual(['b', 'a', 'c']);
  });

  it('formatea lo transcurrido', () => {
    expect(formatElapsed(12_300)).toBe('12 s');
    expect(formatElapsed(185_000)).toBe('3 min 05 s');
    expect(formatElapsed(3_720_000)).toBe('1 h 02 min');
    expect(formatElapsed(-5)).toBe('0 s');
  });

  it('cancelar pide una vez y no adelanta el estado', () => {
    const onCancel = vi.fn();
    render(<JobsPanel jobs={[job({}), job({ id: 'j2', status: 'failed', exitCode: 1, endedAt: Date.now() })]} hasSession onCancel={onCancel} />);
    expect(screen.getByText(/falló · código 1/)).toBeTruthy();
    const cancel = screen.getByRole('button', { name: 'Cancelar' });
    fireEvent.click(cancel);
    expect(onCancel).toHaveBeenCalledWith('j1');
    // Sigue «en marcha» hasta que la foto diga otra cosa.
    expect(screen.getByText('en marcha')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Cancelación pedida…' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('sin poder cancelar (sesión de una terminal) no ofrece el botón', () => {
    render(<JobsPanel jobs={[job({})]} hasSession />);
    expect(screen.queryByRole('button', { name: 'Cancelar' })).toBeNull();
  });

  it('estados vacíos', () => {
    const { rerender } = render(<JobsPanel jobs={[]} hasSession={false} />);
    expect(screen.getByText('Abre una sesión de código para ver sus procesos.')).toBeTruthy();
    rerender(<JobsPanel jobs={[]} hasSession />);
    expect(screen.getByText(/no tiene procesos en segundo plano/)).toBeTruthy();
  });
});

describe('diff', () => {
  const DIFF = [
    'diff --git a/src/app.ts b/src/app.ts',
    'index 1111111..2222222 100644',
    '--- a/src/app.ts',
    '+++ b/src/app.ts',
    '@@ -1,3 +1,3 @@',
    ' const a = 1;',
    '-const b = 2;',
    '+const b = 3;',
    '\\ No newline at end of file',
    '',
  ].join('\n');

  it('clasifica cabecera, hunks y líneas', () => {
    expect(diffLines(DIFF).map((l) => l.kind)).toEqual([
      'meta',
      'meta',
      'meta',
      'meta',
      'hunk',
      'context',
      'del',
      'add',
      'meta',
    ]);
  });

  it('la cabecera `---`/`+++` no cuenta como línea borrada o añadida, pero dentro de un hunk sí', () => {
    const lines = diffLines('--- a/x\n+++ b/x\n@@ -1 +1 @@\n--- era un comentario\n+++ ahora otro\n');
    expect(lines.map((l) => l.kind)).toEqual(['meta', 'meta', 'hunk', 'del', 'add']);
  });

  it('binario, vacío y recortado se dicen', () => {
    const { rerender } = render(<DiffView diff={{ diff: '', truncated: false, binary: true }} />);
    expect(screen.getByText(/Fichero binario/)).toBeTruthy();
    rerender(<DiffView diff={{ diff: '', truncated: false, binary: false }} />);
    expect(screen.getByText('Sin diferencias de contenido.')).toBeTruthy();
    rerender(<DiffView diff={{ diff: DIFF, truncated: true, binary: false }} />);
    expect(screen.getByText(/se enseña solo el principio/)).toBeTruthy();
    expect(document.querySelectorAll('.diff__line[data-kind="add"]')).toHaveLength(1);
  });
});
