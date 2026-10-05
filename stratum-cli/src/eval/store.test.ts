import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { collectRunEnvironment } from './env.js';
import { formatBaselineList, formatEvalReport } from './report.js';
import { summarize, type EvalResult } from './result.js';
import {
  baselineNameProblem,
  deleteBaseline,
  listBaselines,
  listRunIds,
  readBaseline,
  resolveResult,
  saveBaseline,
} from './store.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stratum-store-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const result = (runId: string, over: Partial<EvalResult> = {}): EvalResult => ({
  schemaVersion: 1,
  kind: 'stratum-eval',
  runId,
  startedAt: '2026-03-01T10:00:00.000Z',
  finishedAt: '2026-03-01T10:05:00.000Z',
  stratumVersion: '0.7.0',
  platform: 'linux',
  node: 'v22.0.0',
  mode: 'live',
  provider: { name: 'nan', model: 'glm5.3-flash' },
  env: {
    os: { platform: 'linux', release: '6.8.0', arch: 'x64' },
    git: { commit: 'abc123def456', branch: 'main', dirty: false },
  },
  scenarios: [],
  summary: summarize([]),
  ...over,
});

/** Deja una ejecución en `<dir>/runs/<runId>/result.json`, como el runner. */
function writeRun(r: EvalResult): void {
  mkdirSync(join(dir, 'runs', r.runId), { recursive: true });
  writeFileSync(join(dir, 'runs', r.runId, 'result.json'), JSON.stringify(r), 'utf8');
}

describe('baselines con nombre', () => {
  it('guarda una copia con su metadata y la resuelve por nombre', () => {
    const run = result('20260301-100000-aaaa');
    writeRun(run);
    const saved = saveBaseline(dir, 'live-glm', run, {
      note: 'antes del refactor del loop',
      tolerances: { tokens: { pct: 0.6 } },
      now: Date.parse('2026-03-02T08:00:00.000Z'),
    });
    expect(saved.replaced).toBe(false);
    expect(saved.file).toBe(join(dir, 'baselines', 'live-glm.json'));

    const { result: stored } = resolveResult('live-glm', dir);
    expect(stored.baseline).toEqual({
      name: 'live-glm',
      savedAt: '2026-03-02T08:00:00.000Z',
      runId: '20260301-100000-aaaa',
      note: 'antes del refactor del loop',
      tolerances: { tokens: { pct: 0.6 } },
    });
    // Commit, versión, SO, provider/modelo, modo y fecha viajan con el baseline.
    expect(stored).toMatchObject({
      stratumVersion: '0.7.0',
      mode: 'live',
      provider: { name: 'nan', model: 'glm5.3-flash' },
      startedAt: '2026-03-01T10:00:00.000Z',
      env: { os: { platform: 'linux' }, git: { commit: 'abc123def456', dirty: false } },
    });
    expect(resolveResult('baseline:live-glm', dir).result.runId).toBe(run.runId);
  });

  it('es una copia: sobrevive a que se borre la ejecución de origen', () => {
    const run = result('20260301-100000-aaaa');
    writeRun(run);
    saveBaseline(dir, 'ref', run);
    rmSync(join(dir, 'runs'), { recursive: true, force: true });
    expect(listRunIds(dir)).toEqual([]);
    expect(readBaseline(dir, 'ref').result.runId).toBe(run.runId);
  });

  it('guardar otra vez con el mismo nombre reemplaza y lo dice', () => {
    saveBaseline(dir, 'ref', result('a'));
    const again = saveBaseline(dir, 'ref', result('b'));
    expect(again.replaced).toBe(true);
    expect(readBaseline(dir, 'ref').result.runId).toBe('b');
    expect(listBaselines(dir)).toEqual(['ref']);
  });

  it('sin nota ni tolerancias no deja claves vacías', () => {
    saveBaseline(dir, 'ref', result('a'), { tolerances: {} });
    const { baseline } = readBaseline(dir, 'ref').result;
    expect(Object.keys(baseline!).sort()).toEqual(['name', 'runId', 'savedAt']);
  });

  it('rechaza nombres reservados o que saldrían de la carpeta', () => {
    for (const bad of ['latest', 'current', 'previous', '../fuera', 'Con Mayus', '', 'a/b', '.x']) {
      expect(baselineNameProblem(bad), bad).not.toBeNull();
      expect(() => saveBaseline(dir, bad, result('a')), bad).toThrow();
    }
    expect(existsSync(join(dir, 'baselines'))).toBe(false);
    for (const ok of ['baseline', 'mock', 'live-glm5.3', 'v0.7_linux']) {
      expect(baselineNameProblem(ok), ok).toBeNull();
    }
  });

  it('lista por orden, ignora lo que no es un baseline y borra', () => {
    saveBaseline(dir, 'mock', result('a', { mode: 'mock' }));
    saveBaseline(dir, 'live', result('b'));
    writeFileSync(join(dir, 'baselines', 'notas.txt'), 'x');
    expect(listBaselines(dir)).toEqual(['live', 'mock']);
    expect(deleteBaseline(dir, 'mock')).toBe(true);
    expect(deleteBaseline(dir, 'mock')).toBe(false);
    expect(deleteBaseline(dir, '../runs')).toBe(false);
    expect(listBaselines(dir)).toEqual(['live']);
  });

  it('un fichero que no es un resultado se rechaza con su ruta', () => {
    mkdirSync(join(dir, 'baselines'), { recursive: true });
    writeFileSync(join(dir, 'baselines', 'roto.json'), '{"kind":"otra-cosa"}');
    expect(() => resolveResult('roto', dir)).toThrow(/roto\.json: no es un resultado/);
  });
});

describe('resolveResult', () => {
  it('latest, current y previous miran las ejecuciones, nunca los baselines', () => {
    writeRun(result('20260301-100000-aaaa'));
    writeRun(result('20260302-100000-bbbb'));
    saveBaseline(dir, 'baseline', result('20260101-000000-zzzz'));
    expect(resolveResult('latest', dir).result.runId).toBe('20260302-100000-bbbb');
    expect(resolveResult('current', dir).result.runId).toBe('20260302-100000-bbbb');
    expect(resolveResult('previous', dir).result.runId).toBe('20260301-100000-aaaa');
    // `stratum eval compare baseline current`
    expect(resolveResult('baseline', dir).result.runId).toBe('20260101-000000-zzzz');
  });

  it('un runId gana a un baseline; una ruta sigue valiendo', () => {
    const run = result('20260301-100000-aaaa');
    writeRun(run);
    const file = join(dir, 'runs', run.runId, 'result.json');
    expect(resolveResult(run.runId, dir).result.runId).toBe(run.runId);
    expect(resolveResult(file, dir).result.runId).toBe(run.runId);
    expect(resolveResult(join(dir, 'runs', run.runId), dir).result.runId).toBe(run.runId);
  });

  it('cuando no encuentra nada, enumera los baselines que sí hay', () => {
    expect(() => resolveResult('latest', dir)).toThrow(/No hay ejecución "latest"/);
    expect(() => resolveResult('nada', dir)).toThrow(/no hay ninguno guardado/);
    saveBaseline(dir, 'mock', result('a'));
    expect(() => resolveResult('nada', dir)).toThrow(/un baseline \(mock\)/);
    expect(() => resolveResult('baseline:nada', dir)).toThrow(/No se encuentra/);
  });
});

describe('metadata de la ejecución', () => {
  it('fuera de un repositorio git no hay commit, pero sí sistema', async () => {
    const env = await collectRunEnvironment(dir, null);
    expect(env.git).toBeNull();
    expect(env.os.platform).toBe(process.platform);
    expect(env.os.release.length).toBeGreaterThan(0);
  });

  it('dentro de uno da el commit y si había cambios sin commit', async () => {
    // Aunque se lance desde otra carpeta, manda el checkout de Stratum.
    const env = await collectRunEnvironment(dir);
    expect(env.git?.repo).toBe('stratum');
    expect(env.git?.commit).toMatch(/^[0-9a-f]{12}$/);
    expect((await collectRunEnvironment(process.cwd(), null)).git?.repo).toBe('cwd');
    expect(typeof env.git?.dirty).toBe('boolean');
  });

  it('el informe y el listado enseñan de dónde salió cada resultado', () => {
    const dirty = result('a', {
      env: {
        os: { platform: 'linux', release: '6.8.0', arch: 'x64' },
        git: { commit: 'abc123def456', branch: 'main', dirty: true },
      },
    });
    const report = formatEvalReport(dirty);
    expect(report).toContain('commit abc123def456 (con cambios sin commit)');
    expect(report).toContain('rama main');
    expect(report).toContain('linux 6.8.0');

    saveBaseline(dir, 'live-glm', dirty, { note: 'ref', now: Date.parse('2026-03-02T08:00:00Z') });
    const list = formatBaselineList([readBaseline(dir, 'live-glm').result]);
    for (const part of ['live-glm', 'nan/glm5.3-flash', 'v0.7.0', 'abc123def456+', '2026-03-02']) {
      expect(list, part).toContain(part);
    }
    expect(formatBaselineList([])).toContain('No hay baselines');
    // Un resultado anterior a esta metadata se sigue pintando.
    const old = result('b');
    delete old.env;
    expect(formatEvalReport(old)).toContain('linux · node v22.0.0');
    expect(JSON.parse(readFileSync(join(dir, 'baselines', 'live-glm.json'), 'utf8')).kind).toBe(
      'stratum-eval',
    );
  });
});
