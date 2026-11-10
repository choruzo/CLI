// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { sampleSession } from '../../../stratum-cli/src/protocol/protocol.fixtures';
import type { ProtocolSession } from '../protocol';
import { commandsFor, matchCommands, parseCommand } from '../components/chat/commands';
import {
  MAX_RECENT_PROJECTS,
  loadLastProject,
  loadMode,
  modeOfAgent,
  modeOfSession,
  projectName,
  recentProjects,
  saveLastProject,
  saveMode,
} from './mode';

beforeEach(() => localStorage.clear());

describe('modo de una sesión', () => {
  it('los agentes embebidos son del chat; todo lo demás, de código', () => {
    expect(modeOfAgent('assistant')).toBe('chat');
    expect(modeOfAgent('companion')).toBe('chat');
    expect(modeOfAgent('general')).toBe('code');
    expect(modeOfAgent('reviewer')).toBe('code');
    expect(modeOfSession(sampleSession({ agent: 'assistant' }))).toBe('chat');
  });

  it('el modo y el último proyecto se recuerdan; lo corrupto vuelve al chat', () => {
    expect(loadMode()).toBe('chat');
    saveMode('code');
    expect(loadMode()).toBe('code');
    localStorage.setItem('stratum.desktop.mode', 'otro');
    expect(loadMode()).toBe('chat');
    expect(loadLastProject()).toBeNull();
    saveLastProject('C:\\src\\app');
    expect(loadLastProject()).toBe('C:\\src\\app');
  });
});

describe('proyectos', () => {
  it('nombre corto de una carpeta, con cualquiera de las dos barras', () => {
    expect(projectName('C:\\src\\app\\')).toBe('app');
    expect(projectName('/home/u/proyectos/web')).toBe('web');
    expect(projectName('/')).toBe('/');
  });

  it('recientes: solo sesiones de código vivas, la más reciente primero y sin repetir', () => {
    const session = (id: string, agent: string, cwd: string, updatedAt: number, state: ProtocolSession['state'] = 'idle') =>
      sampleSession({ id, agent, cwd, updatedAt, state });
    const recent = recentProjects({
      sessions: [
        session('a', 'general', 'C:\\src\\uno', 10),
        session('b', 'assistant', 'C:\\desktop\\carpeta', 50),
        session('c', 'general', 'C:\\src\\dos', 30),
        session('d', 'reviewer', 'c:\\src\\UNO\\', 40),
        session('e', 'general', 'C:\\src\\cerrada', 99, 'closed'),
      ],
    });
    expect(recent).toEqual(['c:\\src\\UNO\\', 'C:\\src\\dos']);
  });

  it('no propone más de la cuenta', () => {
    const sessions = Array.from({ length: MAX_RECENT_PROJECTS + 4 }, (_, i) =>
      sampleSession({ id: `s${i}`, agent: 'general', cwd: `/p/${i}`, updatedAt: i }),
    );
    expect(recentProjects({ sessions })).toHaveLength(MAX_RECENT_PROJECTS);
  });
});

describe('slash-commands por modo', () => {
  it('cada modo ofrece los suyos y los comunes', () => {
    const chat = commandsFor('chat').map((c) => c.name);
    const code = commandsFor('code').map((c) => c.name);
    expect(chat).toContain('imagen');
    expect(chat).not.toContain('agent');
    expect(code).toEqual(expect.arrayContaining(['new', 'model', 'agent', 'readonly', 'changes', 'jobs', 'undo']));
    expect(code).not.toContain('imagen');
  });

  it('el menú solo propone los del modo', () => {
    expect(matchCommands('/a', 'chat')).toEqual([]);
    expect(matchCommands('/a', 'code')?.map((c) => c.name)).toEqual(['agent']);
    // Sin modo, el del chat (lo que había antes de los modos).
    expect(matchCommands('/im')?.map((c) => c.name)).toEqual(['imagen']);
  });

  it('un comando del otro modo se explica en vez de enviarse como mensaje', () => {
    expect(parseCommand('/undo', 'chat')).toEqual({ ok: false, error: '/undo es del modo Código.' });
    expect(parseCommand('/imagen un gato', 'code')).toEqual({ ok: false, error: '/imagen es del modo Chat.' });
    expect(parseCommand('/agent reviewer', 'code')).toEqual({ ok: true, name: 'agent', arg: 'reviewer' });
    expect(parseCommand('/readonly ya', 'code')).toEqual({ ok: false, error: '/readonly no admite argumentos.' });
  });
});
