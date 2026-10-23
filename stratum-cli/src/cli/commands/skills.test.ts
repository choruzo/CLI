import { describe, it, expect } from 'vitest';
import { formatSkills, skillsJson } from './skills.js';
import type { SkillEntry } from '../../skills/registry.js';

const entry: SkillEntry = {
  name: 'deploy',
  description: 'Publicar una release',
  path: '/p/.stratum/skills/deploy/SKILL.md',
  scope: 'project',
  source: '.stratum/skills',
  presets: ['coding', 'assistant'],
};

describe('stratum skills list — formato', () => {
  it('sin skills lo dice', () => {
    expect(formatSkills([])).toBe('No hay skills.\n');
  });

  it('una línea por skill y la ruta debajo', () => {
    expect(formatSkills([entry])).toBe(
      'deploy  [project]  coding,assistant  — Publicar una release\n  /p/.stratum/skills/deploy/SKILL.md\n',
    );
  });

  it('--json: array con name, description, scope, presets, path y source', () => {
    expect(JSON.parse(skillsJson([entry]))).toEqual([entry]);
    expect(JSON.parse(skillsJson([]))).toEqual([]);
  });
});
