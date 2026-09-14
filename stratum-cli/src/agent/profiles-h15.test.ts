import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  GENERAL_PROFILE,
  ProfileLoader,
  describeProfile,
  isValidProfileName,
  parseProfile,
  profileMode,
  strictestPolicy,
} from './profiles.js';
import { formatProfilesReport, profilesToJson } from './profiles-report.js';
import {
  PROFILE_INDEX_MAX_ROWS,
  buildAgentProfilesBlock,
  buildSystemPrompt,
} from './system-prompt.js';
import { filterProfiles } from '../cli/ui/session-commands.js';
import { ToolRegistry } from '../tools/registry.js';
import { registerBuiltinTools } from '../tools/index.js';
import { StratumConfigSchema } from '../config/schema.js';
import type { AgentProfile } from './types.js';

const config = StratumConfigSchema.parse({});
const roots: string[] = [];

/** Root de proyecto temporal con `.stratum/agents/<nombre>.md`. */
function projectRoot(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'stratum-h15-'));
  roots.push(root);
  const dir = join(root, '.stratum', 'agents');
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, `${name}.md`), content);
  }
  return root;
}

afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

describe('ProfileLoader — frontmatter del Hito 15', () => {
  it('lee description y mode; sin mode el perfil es subagent', () => {
    const loader = new ProfileLoader(
      projectRoot({
        'h15-rev': `---\ndescription: Reviews diffs\nmode: primary\n---\nYou review.`,
        'h15-old': `---\nallowedTools: [read_file]\n---\nYou are old.`,
      }),
    );
    const rev = loader.resolve('h15-rev')!;
    expect(rev.description).toBe('Reviews diffs');
    expect(profileMode(rev)).toBe('primary');
    expect(profileMode(loader.resolve('h15-old')!)).toBe('subagent');

    expect(loader.delegable().map((p) => p.name)).toContain('h15-old');
    expect(loader.delegable().map((p) => p.name)).not.toContain('h15-rev');
    expect(loader.primaries().map((p) => p.name)).toEqual(['h15-rev']);
  });

  it('una description larga en escalar de bloque plegado queda en una línea', () => {
    const p = parseProfile(
      'x',
      `---\ndescription: >\n  Maps a codebase before\n  any change is made.\n---\nbody`,
    );
    expect(p?.description).toBe('Maps a codebase before any change is made.');
  });

  it('registra el origen: proyecto con ruta, general integrado', () => {
    const root = projectRoot({ 'h15-a': `---\n---\nA` });
    const loader = new ProfileLoader(root);
    expect(loader.resolve('h15-a')?.source?.scope).toBe('project');
    expect(loader.resolve('h15-a')?.source?.path).toContain(join('.stratum', 'agents', 'h15-a.md'));
    expect(loader.resolve('general')?.source?.scope).toBe('builtin');
  });

  it('un frontmatter inválido queda registrado con su error, no desaparece', () => {
    const loader = new ProfileLoader(projectRoot({ 'h15-bad': `---\nmode: boss\n---\nbody` }));
    expect(loader.resolve('h15-bad')).toBeUndefined();
    const [invalid] = loader.invalidProfiles();
    expect(invalid?.name).toBe('h15-bad');
    expect(invalid?.error).toContain('mode');
  });

  it('un override inválido de mayor prioridad enmascara al perfil válido de menor', () => {
    const low = projectRoot({ 'h15-shared': `---\ndescription: from low\n---\nlow` });
    const high = projectRoot({ 'h15-shared': `---\nbudget: { maxIterations: -3 }\n---\nhigh` });
    const loader = new ProfileLoader([low, high]);
    // Si cayera al de menor prioridad, se ejecutaría en silencio el perfil sustituido.
    expect(loader.resolve('h15-shared')).toBeUndefined();
    expect(loader.invalidProfiles().map((i) => i.name)).toContain('h15-shared');
  });

  it('un override válido de mayor prioridad limpia el inválido de menor', () => {
    const low = projectRoot({ 'h15-shared': `---\nmode: boss\n---\nlow` });
    const high = projectRoot({ 'h15-shared': `---\ndescription: from high\n---\nhigh` });
    const loader = new ProfileLoader([low, high]);
    expect(loader.resolve('h15-shared')?.systemPromptFragment).toBe('high');
    expect(loader.invalidProfiles().map((i) => i.name)).not.toContain('h15-shared');
  });

  it('rechaza nombres con mayúsculas y los reservados de /agent', () => {
    expect(isValidProfileName('code')).toBe(true);
    expect(isValidProfileName('code-review.v2')).toBe(true);
    expect(isValidProfileName('Code')).toBe(false);
    expect(isValidProfileName('off')).toBe(false);

    const loader = new ProfileLoader(projectRoot({ Upper: `---\n---\nx`, off: `---\n---\nx` }));
    const errors = Object.fromEntries(loader.invalidProfiles().map((i) => [i.name, i.error]));
    expect(errors['Upper']).toContain('invalid profile name');
    expect(errors['off']).toContain('reserved');
  });
});

describe('describeProfile', () => {
  const base: AgentProfile = { ...GENERAL_PROFILE, name: 'x', description: undefined };

  it('sin description usa la primera línea no vacía del cuerpo', () => {
    expect(describeProfile({ ...base, systemPromptFragment: '\n\nYou map code.\nMore.' })).toBe(
      'You map code.',
    );
  });

  it('escapa | y trunca: nunca rompe la tabla del prompt', () => {
    const text = describeProfile({ ...base, description: `a | b ${'z'.repeat(400)}` });
    expect(text).toContain('a \\| b');
    expect(text.length).toBeLessThanOrEqual(162);
    expect(text).not.toContain('\n');
  });
});

describe('strictestPolicy', () => {
  it('el perfil solo endurece la política de la sesión', () => {
    expect(strictestPolicy('ask', 'deny')).toBe('deny');
    expect(strictestPolicy('deny', 'allow')).toBe('deny');
    expect(strictestPolicy('allow', 'ask')).toBe('ask');
    expect(strictestPolicy('ask', undefined)).toBe('ask');
  });
});

describe('# Agent profiles en el system prompt', () => {
  it('sin filas no hay bloque; con filas, tabla perfil → cuándo usarlo', () => {
    expect(buildAgentProfilesBlock([])).toBe('');
    const block = buildAgentProfilesBlock([{ name: 'research', when: 'Maps code' }]);
    expect(block).toContain('# Agent profiles');
    expect(block).toContain('| research | Maps code |');
  });

  it('corta en el tope de filas y lo dice', () => {
    const rows = Array.from({ length: PROFILE_INDEX_MAX_ROWS + 2 }, (_, i) => ({
      name: `p${i}`,
      when: 'w',
    }));
    const block = buildAgentProfilesBlock(rows);
    expect(block).not.toContain(`| p${PROFILE_INDEX_MAX_ROWS} |`);
    expect(block).toContain('2 more profile(s)');
  });

  it('va en el agente principal y nunca en un subagente', () => {
    const profileIndex = buildAgentProfilesBlock([{ name: 'research', when: 'Maps code' }]);
    expect(buildSystemPrompt(config, undefined, { profileIndex })).toContain('# Agent profiles');
    expect(buildSystemPrompt(config, undefined, { profileIndex, isSubagent: true })).not.toContain(
      '# Agent profiles',
    );
  });

  it('también va con guías por puntero: el índice no es una guía', () => {
    const profileIndex = buildAgentProfilesBlock([{ name: 'research', when: 'Maps code' }]);
    const prompt = buildSystemPrompt(config, undefined, {
      agentProfiles: ['research'],
      profileIndex,
      guides: '# Operating guides\n| x | y | z |',
    });
    expect(prompt).toContain('# Agent profiles');
    expect(prompt).not.toContain('# Work routing');
  });
});

describe('informe de perfiles (/agents, stratum agents list)', () => {
  it('lista modo, origen, tools y los inválidos', () => {
    const loader = new ProfileLoader(
      projectRoot({
        'h15-rev': `---\ndescription: Reviews diffs\nmode: all\nallowedTools: [read_file, grep]\n---\nx`,
        'h15-bad': `---\nmode: boss\n---\nx`,
      }),
    );
    const text = formatProfilesReport(loader.list(), loader.invalidProfiles(), {
      activeName: 'h15-rev',
    });
    expect(text).toContain('◆ h15-rev  [all · proyecto]');
    expect(text).toContain('Reviews diffs');
    expect(text).toContain('tools: read_file, grep');
    expect(text).toContain('• general  [subagent · integrado]');
    expect(text).toContain('Perfiles inválidos (1)');
    expect(text).toContain('✗ h15-bad');

    const json = profilesToJson(loader.list(), loader.invalidProfiles()) as {
      profiles: Array<{ name: string; mode: string; scope: string }>;
    };
    expect(json.profiles.find((p) => p.name === 'h15-rev')).toMatchObject({
      mode: 'all',
      scope: 'project',
    });
  });
});

describe('filterProfiles (paleta @perfil)', () => {
  const rows = [
    { name: 'code', description: 'writes code' },
    { name: 'research', description: 'maps code' },
  ];

  it('filtra por subcadena mientras se escribe el nombre', () => {
    expect(filterProfiles('@', rows).map((c) => c.name)).toEqual(['@code', '@research']);
    expect(filterProfiles('@res', rows).map((c) => c.name)).toEqual(['@research']);
    expect(filterProfiles('@res', rows)[0]?.hasArgs).toBe(true);
  });

  it('se cierra en cuanto empieza la tarea, y no aplica sin @', () => {
    expect(filterProfiles('@research busca X', rows)).toEqual([]);
    expect(filterProfiles('/res', rows)).toEqual([]);
  });
});

describe('ToolsetFilter.controlTools (perfil principal)', () => {
  function names(mode: 'normal' | 'plan', filter: Parameters<ToolRegistry['toToolSchemas']>[1]) {
    const reg = new ToolRegistry();
    registerBuiltinTools(reg, config);
    return reg.toToolSchemas(mode, filter).map((t) => t.function.name);
  }

  it('las tools de control pasan aunque el perfil no las liste; las operativas no', () => {
    const filter = { allowedTools: ['read_file'], controlTools: 'keep' as const };
    const normal = names('normal', filter);
    expect(normal).toContain('read_file');
    expect(normal).toContain('question');
    expect(normal).toContain('todo');
    expect(normal).not.toContain('grep');
    // /plan bajo el perfil: sin present_plan no podría presentar el plan.
    expect(names('plan', filter)).toContain('present_plan');
  });

  it('delegate_task no se cuela: delegar en general devolvería todas las tools', () => {
    expect(names('normal', { allowedTools: ['read_file'], controlTools: 'keep' })).not.toContain(
      'delegate_task',
    );
    expect(
      names('normal', { allowedTools: ['read_file', 'delegate_task'], controlTools: 'keep' }),
    ).toContain('delegate_task');
  });
});
