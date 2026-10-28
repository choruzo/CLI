import { describe, expect, it } from 'vitest';
import type { TraceData, TraceRecord } from '../trace/records.js';
import { ReplayError, relativizer, scenarioFromTrace, scriptFromTrace } from './replay.js';

let at = 0;
const meta = (cwd = '/home/u/proj'): TraceRecord => ({
  t: 'meta',
  v: 1,
  at: ++at,
  sessionId: 'S1',
  cwd,
  caps: ['runtime', 'llm-origin'],
});
const turn = (input: string): TraceRecord => ({ t: 'turn', at: ++at, input });
/** Una llamada al modelo cerrada, con lo que respondió. */
const call = (
  id: string,
  end: TraceData,
  opts: { origin?: string; status?: 'ok' | 'error' } = {},
): TraceRecord[] => [
  {
    t: 'begin',
    at: ++at,
    id,
    kind: 'model',
    name: 'm',
    data: { origin: opts.origin ?? 'agent' },
  },
  { t: 'end', at: ++at, id, status: opts.status ?? 'ok', data: end },
];
const tc = (name: string, args: string) => ({ id: 'x', name, arguments: args });
const notice = (id: string, data: TraceData): TraceRecord => ({
  t: 'point',
  at: ++at,
  id,
  kind: 'notice',
  name: 'n',
  data,
});

const problemsOf = (records: TraceRecord[]): readonly string[] => {
  try {
    scriptFromTrace(records);
    return [];
  } catch (err) {
    if (err instanceof ReplayError) return err.problems;
    throw err;
  }
};

describe('scriptFromTrace', () => {
  it('las respuestas del loop, en orden, con turnos siguientes como followUps', () => {
    const r = scriptFromTrace([
      meta(),
      turn('crea a.txt'),
      ...call('m1', { toolCalls: [tc('write_file', '{"path":"a.txt","content":"hola"}')] }),
      ...call('x1', { text: 'decisiones' }, { origin: 'memory-extraction' }),
      ...call('m2', { text: 'Hecho.', reasoning: 'pienso' }),
      turn('y ahora b'),
      ...call('m3', {}),
    ]);
    expect(r.input).toBe('crea a.txt');
    expect(r.followUps).toEqual(['y ahora b']);
    expect(r.script).toEqual([
      { toolCalls: [{ name: 'write_file', args: { path: 'a.txt', content: 'hola' } }] },
      { text: 'Hecho.', reasoning: 'pienso' },
      { text: '' },
    ]);
    expect(r.notes.join('\n')).toContain('memory-extraction');
  });

  it('reescribe como relativas las rutas bajo el cwd grabado', () => {
    const r = scriptFromTrace([
      meta('D:\\Proyectos\\demo'),
      turn('x'),
      ...call('m1', {
        toolCalls: [
          tc('read_file', JSON.stringify({ path: 'd:/proyectos/demo/src/a.ts' })),
          tc(
            'exec',
            JSON.stringify({ command: 'cd D:\\Proyectos\\demo && ls', cwd: 'D:\\Proyectos\\demo' }),
          ),
          tc('read_file', JSON.stringify({ path: 'D:\\Proyectos\\demo2\\a.ts' })),
        ],
      }),
    ]);
    expect(r.script[0]!.toolCalls!.map((c) => c.args)).toEqual([
      { path: 'src/a.ts' },
      { command: 'cd . && ls', cwd: '.' },
      { path: 'D:\\Proyectos\\demo2\\a.ts' },
    ]);
    expect(r.notes.join('\n')).toContain('2 llamadas con rutas');
  });

  it('una ruta posix distingue mayúsculas y un cwd raíz no se toca', () => {
    expect(relativizer('/home/u')({ p: '/home/u/a', q: '/HOME/u/a' })).toEqual({
      p: 'a',
      q: '/HOME/u/a',
    });
    expect(relativizer('/')({ p: '/etc/hosts' })).toEqual({ p: '/etc/hosts' });
  });

  it('falla cerrado con lo que el guion no puede repetir, y lo dice todo junto', () => {
    const problems = problemsOf([
      meta(),
      turn('x'),
      ...call('m1', {
        toolCalls: [
          tc('exec', '{"command":"echo [redacted: API key]"}'),
          tc('write_file', '{"path":"a"\n… [trace: 10 more chars]'),
          tc('grep', '{"pattern":'),
        ],
      }),
      ...call('m2', { error: '503' }, { status: 'error' }),
      notice('r', { event: 'retry', attempt: 1, error: '503' }),
      notice('c', { event: 'confirmation', decision: 'approved', tool: 'exec' }),
      notice('i', { event: 'inbox', phase: 'enqueue', type: 'user-message' }),
      ...call('k', { text: 'resumen' }, { origin: 'context-compression' }),
    ]);
    expect(problems).toHaveLength(8);
    expect(problems.join('\n')).toMatch(/secretos redactados/);
    expect(problems.join('\n')).toMatch(/recortado/);
    expect(problems.join('\n')).toMatch(/no son JSON/);
    expect(problems.join('\n')).toMatch(/estado error/);
    expect(problems.join('\n')).toMatch(/reintento/);
    expect(problems.join('\n')).toMatch(/confirmación aprobada/);
    expect(problems.join('\n')).toMatch(/steering/);
    expect(problems.join('\n')).toMatch(/compresión de contexto/);
  });

  it('una confirmación bloqueada o denegada sí se reproduce (sin TTY también se bloquea)', () => {
    expect(
      problemsOf([
        meta(),
        turn('x'),
        ...call('m1', { toolCalls: [tc('exec', '{"command":"rm x"}')] }),
        notice('c', { event: 'confirmation', decision: 'denied', tool: 'exec' }),
        ...call('m2', { text: 'vale' }),
      ]),
    ).toEqual([]);
  });

  it('rechaza una sesión reanudada y llamadas del loop solapadas', () => {
    const solapadas: TraceRecord[] = [
      meta(),
      turn('x'),
      { t: 'begin', at: 10, id: 'a', kind: 'model', name: 'm', data: { origin: 'subagent' } },
      { t: 'begin', at: 11, id: 'b', kind: 'model', name: 'm', data: { origin: 'subagent' } },
      { t: 'end', at: 12, id: 'a', status: 'ok', data: { text: '1' } },
      { t: 'end', at: 13, id: 'b', status: 'ok', data: { text: '2' } },
    ];
    expect(problemsOf(solapadas).join('\n')).toMatch(/solapadas/);
    expect(problemsOf([meta(), turn('x'), ...call('m', { text: 'a' }), meta()]).join('\n')).toMatch(
      /2 cabeceras/,
    );
  });
});

describe('scenarioFromTrace', () => {
  it('escenario válido del grupo replay que puntúa el workspace, sin defaults en el JSON', () => {
    const { scenario, json } = scenarioFromTrace(
      [meta(), turn('crea a.txt'), ...call('m1', { text: 'ok' })],
      { id: 'replay-demo', setup: { 'b.txt': 'b' }, expected: { 'a.txt': 'hola', 'b.txt': 'b' } },
    );
    expect(scenario.group).toBe('replay');
    expect(scenario.setup.files).toEqual({ 'b.txt': 'b' });
    expect(scenario.expect.checks).toEqual([
      { type: 'workspace_expected', files: { 'a.txt': 'hola', 'b.txt': 'b' }, strict: true },
    ]);
    const raw = JSON.parse(json) as Record<string, unknown>;
    expect(raw.followUps).toBeUndefined();
    expect(raw.run).toBeUndefined();
  });

  it('un id que no vale es un error del schema', () => {
    expect(() =>
      scenarioFromTrace([meta(), turn('x'), ...call('m1', { text: 'ok' })], {
        id: 'Replay Malo',
        setup: {},
        expected: {},
      }),
    ).toThrow(ReplayError);
  });
});
