import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { evaluateChecks, findUnsafeActions, type CheckContext } from './checks.js';
import { buildTraceModel, computeMetrics } from './metrics.js';
import {
  bundledScenariosDir,
  DIFFICULTIES,
  filterScenarios,
  liveTrajectoryChecks,
  loadScenarios,
  parseScenario,
  scenarioFingerprint,
  ScenarioError,
  ScenarioSchema,
  SCENARIO_GROUPS,
} from './scenario.js';
import type { TraceRecord } from '../trace/records.js';

const minimal = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'demo-scenario',
  group: 'code',
  title: 'Demo',
  input: 'haz algo',
  expect: { description: 'algo hecho', checks: [{ type: 'exit_code', equals: 0 }] },
  ...over,
});

const problems = (raw: Record<string, unknown>): string[] => {
  const r = ScenarioSchema.safeParse(raw);
  return r.success ? [] : r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
};

describe('ScenarioSchema', () => {
  it('acepta el escenario mínimo y rellena los defaults', () => {
    const s = ScenarioSchema.parse(minimal());
    expect(s.setup).toEqual({ files: {}, commands: [], config: {} });
    expect(s.run).toEqual({ args: [], timeoutMs: 180_000 });
    expect(s.expect.forbidden).toEqual([]);
  });

  it('rechaza ids, grupos y claves desconocidas', () => {
    expect(problems(minimal({ id: 'Con Mayúsculas' }))).toHaveLength(1);
    expect(problems(minimal({ group: 'otro' }))).toHaveLength(1);
    expect(problems(minimal({ sorpresa: true }))).toHaveLength(1);
  });

  it('exige al menos un criterio de éxito', () => {
    expect(problems(minimal({ expect: { description: 'x', checks: [] } }))).toHaveLength(1);
  });

  it('un fichero de setup o de un criterio no puede salir del workspace', () => {
    expect(problems(minimal({ setup: { files: { '../fuera.txt': 'x' } } }))).not.toEqual([]);
    expect(problems(minimal({ setup: { files: { '/etc/passwd': 'x' } } }))).not.toEqual([]);
    expect(problems(minimal({ setup: { files: { 'C:\\x.txt': 'x' } } }))).not.toEqual([]);
    const check = { type: 'file_exists', path: 'a/../../b' };
    expect(problems(minimal({ expect: { description: 'x', checks: [check] } }))).not.toEqual([]);
  });

  it('solo admite flags de `run` conocidos', () => {
    expect(problems(minimal({ run: { args: ['--read-only', '--delegate', 'general'] } }))).toEqual(
      [],
    );
    expect(problems(minimal({ run: { args: ['--provider', 'otro'] } }))[0]).toContain('--provider');
    expect(problems(minimal({ run: { args: ['--agent'] } }))[0]).toContain('--agent');
  });

  it('valida las expresiones regulares y las cotas de `metric`', () => {
    const withCheck = (check: unknown): string[] =>
      problems(minimal({ expect: { description: 'x', checks: [check] } }));
    expect(withCheck({ type: 'output_matches', pattern: '(' })).not.toEqual([]);
    expect(withCheck({ type: 'metric', metric: 'toolCalls' })[0]).toContain('min, max o equals');
    expect(withCheck({ type: 'metric', metric: 'toolCalls', max: 3 })).toEqual([]);
    expect(withCheck({ type: 'metric', metric: 'inventada', max: 3 })).not.toEqual([]);
  });

  it('un paso de guion vacío es un error', () => {
    expect(problems(minimal({ script: [{}] }))).not.toEqual([]);
    expect(problems(minimal({ script: [{ text: 'hola' }] }))).toEqual([]);
  });

  it('parseScenario explica qué falla y en qué fichero', () => {
    expect(() => parseScenario('{ roto', 'a.json')).toThrow(/a\.json: JSON no válido/);
    expect(() => parseScenario(JSON.stringify(minimal({ group: 'x' })), 'b.json')).toThrow(
      ScenarioError,
    );
  });
});

describe('loadScenarios', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'stratum-scn-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const write = (path: string, raw: unknown): void => {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), typeof raw === 'string' ? raw : JSON.stringify(raw));
  };

  it('recorre subcarpetas, ordena por grupo y aparta los ficheros rotos', () => {
    write('a/ssh/uno.json', minimal({ id: 'zz-ssh', group: 'ssh' }));
    write('a/code/dos.json', minimal({ id: 'aa-code' }));
    write('a/roto.json', '{ nope');
    const set = loadScenarios([join(dir, 'a')]);
    expect(set.scenarios.map((s) => s.id)).toEqual(['aa-code', 'zz-ssh']);
    expect(set.errors).toHaveLength(1);
  });

  it('la carpeta posterior gana ante el mismo id; repetido en la misma es error', () => {
    write('base/x.json', minimal({ title: 'incluido' }));
    write('proj/x.json', minimal({ title: 'del proyecto' }));
    write('proj/y.json', minimal({ title: 'duplicado' }));
    const set = loadScenarios([join(dir, 'base'), join(dir, 'proj')]);
    expect(set.scenarios).toHaveLength(1);
    expect(set.scenarios[0]!.title).toBe('del proyecto');
    expect(set.errors[0]).toContain('id repetido');
  });

  it('una carpeta que no existe no es un error', () => {
    expect(loadScenarios([join(dir, 'nada')])).toEqual({ scenarios: [], errors: [] });
  });

  it('filtra por id y por grupo', () => {
    write('a/1.json', minimal({ id: 'uno' }));
    write('a/2.json', minimal({ id: 'dos', group: 'safety' }));
    const { scenarios } = loadScenarios([join(dir, 'a')]);
    expect(filterScenarios(scenarios, { groups: ['safety'] }).map((s) => s.id)).toEqual(['dos']);
    expect(filterScenarios(scenarios, { ids: ['uno'] }).map((s) => s.id)).toEqual(['uno']);
    expect(filterScenarios(scenarios, {})).toHaveLength(2);
  });
});

describe('dificultad, huella y criterios de trayectoria', () => {
  const parse = (over: Record<string, unknown> = {}) => ScenarioSchema.parse(minimal(over));
  const withChecks = (checks: unknown[]) => parse({ expect: { description: 'x', checks } });

  it('un escenario sin `difficulty` es basic; un nivel desconocido se rechaza', () => {
    expect(parse().difficulty).toBe('basic');
    expect(parse({ difficulty: 'adversarial' }).difficulty).toBe('adversarial');
    expect(problems(minimal({ difficulty: 'hard' })).join(' ')).toContain('difficulty');
  });

  it('filtra por dificultad, sola o combinada con el grupo', () => {
    const all = [
      { ...parse({ id: 'a-1' }), file: 'a' },
      { ...parse({ id: 'b-1', difficulty: 'adversarial' }), file: 'b' },
      { ...parse({ id: 'c-1', group: 'ssh', difficulty: 'adversarial' }), file: 'c' },
    ];
    const ids = (f: Parameters<typeof filterScenarios>[1]) =>
      filterScenarios(all, f).map((s) => s.id);
    expect(ids({ difficulties: ['adversarial'] })).toEqual(['b-1', 'c-1']);
    expect(ids({ difficulties: ['adversarial'], groups: ['ssh'] })).toEqual(['c-1']);
    expect(ids({ difficulties: ['basic', 'intermediate'] })).toEqual(['a-1']);
  });

  it('la huella cambia con lo que se ejecuta o se puntúa, no con el título ni el nivel', () => {
    const base = scenarioFingerprint(parse());
    expect(scenarioFingerprint(parse({ title: 'Otro', difficulty: 'adversarial' }))).toBe(base);
    expect(scenarioFingerprint(parse({ description: 'nota' }))).toBe(base);
    expect(scenarioFingerprint(parse({ input: 'haz otra cosa' }))).not.toBe(base);
    expect(scenarioFingerprint(parse({ setup: { files: { 'a.txt': 'x' } } }))).not.toBe(base);
    expect(
      scenarioFingerprint(
        parse({
          expect: { description: 'algo hecho', checks: [{ type: 'exit_code', equals: 1 }] },
        }),
      ),
    ).not.toBe(base);
  });

  it('señala los criterios que atan la trayectoria de un modelo real', () => {
    const flagged = liveTrajectoryChecks(
      withChecks([
        { type: 'tool_called', tool: 'read_file' },
        { type: 'runtime_event', event: 'veto' },
        { type: 'metric', metric: 'toolErrors', equals: 1 },
        { type: 'metric', metric: 'subagents', min: 1 },
        { type: 'tool_output_contains', value: 'x' },
      ]),
    );
    expect(flagged).toHaveLength(5);
    expect(flagged[0]).toContain('expect.checks[0] (tool_called)');
  });

  it('resultado, seguridad y cotas superiores valen en los dos modos', () => {
    expect(
      liveTrajectoryChecks(
        withChecks([
          { type: 'exit_code', equals: 0 },
          { type: 'output_contains', value: 'x' },
          { type: 'file_exists', path: 'a.txt' },
          { type: 'command', run: ['node', 'check.js'] },
          { type: 'tool_called', tool: 'write_file', min: 0, max: 0 },
          { type: 'runtime_event', event: 'retry', min: 0, max: 2 },
          { type: 'metric', metric: 'toolCalls', max: 10 },
          { type: 'metric', metric: 'llmErrors', equals: 0 },
          { type: 'tool_output_contains', value: 'secreto', negate: true },
          { type: 'host_received', host: 'web1', pattern: 'restart' },
          // Con `mode: mock` no se le impone nada al modelo real.
          { type: 'tool_called', tool: 'read_file', mode: 'mock' },
          { type: 'metric', metric: 'toolErrors', equals: 1, mode: 'mock' },
        ]),
      ),
    ).toEqual([]);
  });
});

describe('escenarios incluidos', () => {
  const dir = bundledScenariosDir();
  const set = loadScenarios(dir ? [dir] : []);

  it('todos cargan sin errores', () => {
    expect(dir).not.toBeNull();
    expect(set.errors).toEqual([]);
    expect(set.scenarios.length).toBeGreaterThanOrEqual(15);
  });

  it('cubren todos los grupos y todos traen guion para --mock', () => {
    for (const group of SCENARIO_GROUPS) {
      expect(
        set.scenarios.some((s) => s.group === group),
        group,
      ).toBe(true);
    }
    expect(set.scenarios.filter((s) => !s.script).map((s) => s.id)).toEqual([]);
  });

  it('ninguno ata la trayectoria en live: eso queda para --mock', () => {
    const flagged = set.scenarios.flatMap((s) =>
      liveTrajectoryChecks(s).map((w) => `${s.id}: ${w}`),
    );
    expect(flagged).toEqual([]);
  });

  it('hay escenarios de los tres niveles, y adversariales donde más importan', () => {
    for (const difficulty of DIFFICULTIES) {
      expect(
        set.scenarios.filter((s) => s.difficulty === difficulty).length,
        difficulty,
      ).toBeGreaterThanOrEqual(5);
    }
    for (const group of ['linux', 'ssh', 'safety', 'recovery'] as const) {
      const inGroup = set.scenarios.filter((s) => s.group === group);
      expect(
        inGroup.some((s) => s.difficulty === 'adversarial'),
        group,
      ).toBe(true);
      // No solo el camino feliz.
      expect(inGroup.filter((s) => s.difficulty !== 'basic').length, group).toBeGreaterThanOrEqual(
        2,
      );
    }
  });

  it('un escenario que ordena algo destructivo no lo deja correr en la máquina real', () => {
    // Los comandos peligrosos van contra hosts simulados; el shell local queda
    // en solo lectura por si un modelo real se equivoca de destino.
    const dangerous = /rm\s+-[a-z]*r[a-z]*f?\s+\/|find\s+\/|mkfs|dd\s+if=/;
    for (const s of set.scenarios) {
      const commands = (s.script ?? []).flatMap((step) =>
        (step.toolCalls ?? []).map((c) => c.args as { target?: string; command?: string }),
      );
      const risky = commands.filter((c) => dangerous.test(c.command ?? ''));
      if (risky.length === 0 && !dangerous.test(s.input)) continue;
      expect(
        risky.every((c) => c.target?.startsWith('ssh:')),
        `${s.id}: comando peligroso sin target ssh`,
      ).toBe(true);
      const environments = (s.setup.config.environments ?? {}) as Record<
        string,
        { match?: string[]; readOnly?: boolean }
      >;
      expect(
        Object.values(environments).some((e) => e.match?.includes('local') && e.readOnly === true),
        `${s.id}: sin entorno local de solo lectura`,
      ).toBe(true);
    }
  });

  it('cada fichero vive en la carpeta de su grupo y se llama como su id', () => {
    for (const s of set.scenarios) {
      expect(s.file.replace(/\\/g, '/').endsWith(`${s.group}/${s.id}.json`), s.file).toBe(true);
    }
  });
});

describe('criterios', () => {
  let work: string;
  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'stratum-chk-'));
    writeFileSync(join(work, 'out.txt'), 'timeout = 60\n');
  });
  afterEach(() => rmSync(work, { recursive: true, force: true }));

  const records: TraceRecord[] = [
    { t: 'meta', v: 1, at: 1, sessionId: 's', caps: ['runtime'] },
    { t: 'turn', at: 2, input: 'x' },
    {
      t: 'begin',
      at: 3,
      id: 'a',
      kind: 'tool',
      name: 'exec',
      data: { callId: 'c1', input: { command: 'rm -rf /' } },
    },
    {
      t: 'point',
      at: 4,
      id: 'v',
      kind: 'notice',
      name: 'veto',
      data: { event: 'veto', source: 'preflight', tool: 'exec', callId: 'c1' },
    },
    { t: 'end', at: 5, id: 'a', status: 'error', data: { error: 'blocked' } },
    {
      t: 'begin',
      at: 6,
      id: 'b',
      kind: 'tool',
      name: 'exec',
      data: { callId: 'c2', input: { command: 'cat secreto.txt' } },
    },
    { t: 'end', at: 7, id: 'b', status: 'error', data: { error: 'exit 1', executed: true } },
    {
      t: 'begin',
      at: 8,
      id: 'c',
      kind: 'tool',
      name: 'read_file',
      data: { callId: 'c3', input: { path: 'out.txt' } },
    },
    { t: 'end', at: 9, id: 'c', status: 'ok', data: { output: 'x' } },
    { t: 'turn_end', at: 10, stopReason: 'stop' },
  ];
  const ctx = (mode: 'mock' | 'live' = 'mock'): CheckContext => ({
    mode,
    workDir: work,
    exitCode: 0,
    output: 'El valor es 60.',
    model: buildTraceModel(records),
    metrics: computeMetrics(records),
    hostReceived: { web1: ['uname -r', 'sudo systemctl restart nginx'], web2: [] },
  });
  const run = async (check: unknown, mode?: 'mock' | 'live') => {
    const parsed = ScenarioSchema.parse(minimal({ expect: { description: 'x', checks: [check] } }));
    return evaluateChecks(parsed.expect.checks, ctx(mode));
  };
  const passes = async (check: unknown): Promise<boolean> => (await run(check))[0]!.pass;

  it('salida, exit code y stopReason', async () => {
    expect(await passes({ type: 'output_contains', value: 'VALOR ES 60' })).toBe(true);
    expect(await passes({ type: 'output_contains', value: 'VALOR', ignoreCase: false })).toBe(
      false,
    );
    expect(await passes({ type: 'output_contains', value: '99', negate: true })).toBe(true);
    expect(await passes({ type: 'output_matches', pattern: '\\b60\\b' })).toBe(true);
    expect(await passes({ type: 'exit_code', equals: 1 })).toBe(false);
    expect(await passes({ type: 'stop_reason', equals: 'stop' })).toBe(true);
  });

  it('ficheros del workspace', async () => {
    expect(await passes({ type: 'file_exists', path: 'out.txt' })).toBe(true);
    expect(await passes({ type: 'file_absent', path: 'out.txt' })).toBe(false);
    expect(await passes({ type: 'file_contains', path: 'out.txt', value: 'timeout = 60' })).toBe(
      true,
    );
    expect(
      await passes({ type: 'file_matches', path: 'out.txt', pattern: 'timeout\\s*=\\s*30' }),
    ).toBe(false);
    // Un fichero que no existe no «no contiene» nada: es un fallo.
    expect(await passes({ type: 'file_contains', path: 'no.txt', value: 'x', negate: true })).toBe(
      false,
    );
  });

  it('comandos sin shell en el workspace', async () => {
    const node = process.execPath;
    expect(await passes({ type: 'command', run: [node, '-e', 'process.exit(0)'] })).toBe(true);
    expect(await passes({ type: 'command', run: [node, '-e', 'process.exit(3)'] })).toBe(false);
    expect(
      await passes({ type: 'command', run: [node, '-e', 'process.exit(3)'], exitCode: 3 }),
    ).toBe(true);
    expect(
      await passes({
        type: 'command',
        run: [node, '-p', 'require("fs").readdirSync(".").join()'],
        stdoutContains: 'out.txt',
      }),
    ).toBe(true);
    expect(await passes({ type: 'command', run: ['no-existe-este-binario-xyz'] })).toBe(false);
  });

  it('llamadas a tools por estado y por argumentos', async () => {
    expect(await passes({ type: 'tool_called', tool: 'exec', min: 2, max: 2 })).toBe(true);
    expect(await passes({ type: 'tool_called', tool: 'exec', status: 'executed', max: 1 })).toBe(
      true,
    );
    expect(
      await passes({
        type: 'tool_called',
        tool: 'exec',
        input: 'rm -rf',
        status: 'executed',
        min: 0,
        max: 0,
      }),
    ).toBe(true);
    expect(await passes({ type: 'tool_called', tool: 'read_file', status: 'ok' })).toBe(true);
    expect(await passes({ type: 'tool_called', tool: 'write_file' })).toBe(false);
  });

  it('métricas y eventos del runtime', async () => {
    expect(await passes({ type: 'metric', metric: 'toolCalls', equals: 3 })).toBe(true);
    expect(await passes({ type: 'metric', metric: 'policyBlocks', min: 1 })).toBe(true);
    expect(await passes({ type: 'metric', metric: 'toolErrors', max: 0 })).toBe(false);
    // Sin `usage` no hay tokens: la cota no se da por cumplida.
    expect(await passes({ type: 'metric', metric: 'tokens', max: 999_999 })).toBe(false);
    expect(
      await passes({ type: 'runtime_event', event: 'veto', detail: 'preflight', tool: 'exec' }),
    ).toBe(true);
    expect(await passes({ type: 'runtime_event', event: 'confirmation' })).toBe(false);
  });

  it('lo que llegó al modelo por la salida de una tool', async () => {
    expect(await passes({ type: 'tool_output_contains', value: 'exit 1' })).toBe(true);
    expect(await passes({ type: 'tool_output_contains', value: 'exit 1', tool: 'read_file' })).toBe(
      false,
    );
    expect(await passes({ type: 'tool_output_contains', value: 'BEGIN KEY', negate: true })).toBe(
      true,
    );
    expect(await passes({ type: 'tool_output_contains', value: 'blocked', negate: true })).toBe(
      false,
    );
  });

  it('comandos recibidos por un host simulado', async () => {
    expect(await passes({ type: 'host_received', host: 'web1', pattern: 'restart\\s+nginx' })).toBe(
      true,
    );
    expect(await passes({ type: 'host_received', host: 'web1', pattern: 'uname', max: 0 })).toBe(
      false,
    );
    expect(
      await passes({ type: 'host_received', host: 'web2', pattern: 'restart', min: 0, max: 0 }),
    ).toBe(true);
    expect(await passes({ type: 'host_received', host: 'web2', pattern: 'restart' })).toBe(false);
    // Un host que el escenario no define no se da por bueno, ni con max: 0.
    const [missing] = await run({
      type: 'host_received',
      host: 'web9',
      pattern: 'x',
      min: 0,
      max: 0,
    });
    expect(missing).toMatchObject({ pass: false, detail: 'el escenario no define el host web9' });
  });

  it('un criterio de otro modo se omite', async () => {
    expect(await run({ type: 'exit_code', equals: 9, mode: 'live' }, 'mock')).toEqual([]);
    expect(await run({ type: 'exit_code', equals: 9, mode: 'live' }, 'live')).toHaveLength(1);
  });

  it('acción insegura = llamada prohibida que llegó a ejecutarse', () => {
    const model = buildTraceModel(records);
    // Vetada: no se ejecutó.
    expect(findUnsafeActions([{ tool: 'exec', input: 'rm -rf' }], model)).toEqual([]);
    // Se ejecutó aunque saliera con error.
    const unsafe = findUnsafeActions(
      [{ tool: 'exec', input: 'secreto', label: 'lee el secreto' }],
      model,
    );
    expect(unsafe).toHaveLength(1);
    expect(unsafe[0]).toMatchObject({ rule: 'lee el secreto', tool: 'exec' });
  });
});
