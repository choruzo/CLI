import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  declineProjectPreset,
  projectConfigTarget,
  projectPresetOffer,
  writeProjectPreset,
} from './project-preset.js';

let root: string;
let home: string;
let globalPath: string;
let statePath: string;
let project: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'stratum-preset-'));
  home = join(root, 'home');
  globalPath = join(home, '.stratum', '.stratumrc.json');
  statePath = join(home, '.stratum', 'state', 'project-config.json');
  project = join(root, 'work', 'proj');
  mkdirSync(join(home, '.stratum'), { recursive: true });
  mkdirSync(project, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const opts = () => ({ globalPath, statePath, home });
const readJson = (p: string) => JSON.parse(readFileSync(p, 'utf-8')) as Record<string, unknown>;

describe('writeProjectPreset', () => {
  it('copia los turnos de la global, no lleva provider y fija la memoria en el proyecto', () => {
    writeFileSync(
      globalPath,
      JSON.stringify({
        provider: {
          default: 'nan',
          providers: { nan: { type: 'openai-compatible', baseUrl: 'http://x.test/v1' } },
        },
        agent: { maxIterations: 120 },
        agents: { maxConcurrency: 3 },
        memory: { decisionsFile: '~/compartida/decisions.json' },
      }),
    );
    const path = join(project, '.stratumrc.json');

    expect(writeProjectPreset(path, globalPath)).toBe(true);
    expect(readJson(path)).toEqual({
      agent: { maxIterations: 120 },
      agents: { maxConcurrency: 3, subagentMaxIterations: 50 },
      memory: {
        projectFile: './STRATUM.md',
        decisionsFile: './.stratum/memory/decisions.json',
        vectorDb: './.stratum/memory/vectors.db',
      },
    });
  });

  it('sin global usa los defaults', () => {
    const path = join(project, '.stratumrc.json');
    writeProjectPreset(path, globalPath);
    expect(readJson(path)['agent']).toEqual({ maxIterations: 50 });
  });

  it('no toca un fichero que ya existe', () => {
    const path = join(project, '.stratumrc.json');
    writeFileSync(path, '{"agent":{"maxIterations":7}}');
    expect(writeProjectPreset(path, globalPath)).toBe(false);
    expect(readJson(path)).toEqual({ agent: { maxIterations: 7 } });
  });
});

describe('projectConfigTarget', () => {
  it('en un repo, la raíz del repo', () => {
    mkdirSync(join(project, '.git'));
    const sub = join(project, 'src', 'deep');
    mkdirSync(sub, { recursive: true });
    expect(projectConfigTarget(sub, globalPath)).toEqual({
      path: join(project, '.stratumrc.json'),
      exists: false,
    });
  });

  it('la config más cercana hacia arriba si ya hay una', () => {
    const parent = join(root, 'work', '.stratumrc.json');
    writeFileSync(parent, '{}');
    expect(projectConfigTarget(project, globalPath)).toEqual({ path: parent, exists: true });
  });
});

describe('projectPresetOffer', () => {
  it('se ofrece en una carpeta sin config', () => {
    expect(projectPresetOffer(project, opts())).toBe(join(project, '.stratumrc.json'));
  });

  it('no se ofrece si ya hay config de proyecto', () => {
    writeFileSync(join(project, '.stratumrc.json'), '{}');
    expect(projectPresetOffer(project, opts())).toBeNull();
  });

  it('no se ofrece en el home ni dentro de ~/.stratum', () => {
    expect(projectPresetOffer(home, opts())).toBeNull();
    const inside = join(home, '.stratum', 'companion');
    mkdirSync(inside, { recursive: true });
    expect(projectPresetOffer(inside, opts())).toBeNull();
  });

  it('un «no» se recuerda para esa carpeta', () => {
    declineProjectPreset(project, statePath);
    expect(projectPresetOffer(project, opts())).toBeNull();
    // Otra carpeta sí pregunta.
    const other = join(root, 'work', 'otro');
    mkdirSync(other);
    expect(projectPresetOffer(other, opts())).toBe(join(other, '.stratumrc.json'));
    // Declinar dos veces no duplica.
    declineProjectPreset(project, statePath);
    expect((readJson(statePath)['declined'] as string[]).length).toBe(1);
  });

  it('un estado de un Stratum más nuevo ni se reescribe ni pregunta', () => {
    mkdirSync(join(home, '.stratum', 'state'), { recursive: true });
    const newer = '{"schemaVersion":99,"declined":[]}';
    writeFileSync(statePath, newer);
    expect(projectPresetOffer(project, opts())).toBeNull();
    declineProjectPreset(project, statePath);
    expect(readFileSync(statePath, 'utf-8')).toBe(newer);
  });
});
