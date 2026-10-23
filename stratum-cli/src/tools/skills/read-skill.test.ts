import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { readSkillTool } from './read-skill.js';
import { SkillRegistry } from '../../skills/registry.js';
import { StratumConfigSchema } from '../../config/schema.js';
import type { ToolContext } from '../../agent/types.js';

let base: string;
let root: string;
let secret: string;

function ctx(skills?: SkillRegistry): ToolContext {
  return {
    signal: new AbortController().signal,
    cwd: root,
    config: StratumConfigSchema.parse({}),
    skills,
  } as ToolContext;
}

function registry(): SkillRegistry {
  return new SkillRegistry([root], { home: join(base, 'home'), builtinDir: null });
}

function writeSkill(name: string, content: string): string {
  const dir = join(root, '.stratum', 'skills', name);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'SKILL.md');
  writeFileSync(file, content, 'utf-8');
  return file;
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'stratum-readskill-'));
  root = join(base, 'project');
  mkdirSync(root, { recursive: true });
  secret = join(base, 'secret.txt');
  writeFileSync(secret, 'TOP-SECRET-CONTENT', 'utf-8');
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('read_skill', () => {
  it('devuelve «# Skill: <name>» y el cuerpo sin frontmatter', async () => {
    writeSkill('deploy', '---\nname: deploy\ndescription: Publicar\n---\n\nPaso 1\nPaso 2\n');
    const r = await readSkillTool.execute({ name: 'deploy' }, ctx(registry()));
    expect(r).toEqual({ ok: true, output: '# Skill: deploy\n\nPaso 1\nPaso 2' });
    expect(r.ok && r.output).not.toContain('description:');
  });

  it('normaliza el nombre al resolver', async () => {
    writeSkill('deploy', '---\nname: deploy\ndescription: d\n---\ncuerpo');
    const r = await readSkillTool.execute({ name: 'Deploy' }, ctx(registry()));
    expect(r.ok).toBe(true);
  });

  it('un nombre desconocido es un error recuperable que lista las disponibles', async () => {
    writeSkill('deploy', '---\nname: deploy\ndescription: d\n---\ncuerpo');
    writeSkill('lint', '---\nname: lint\ndescription: d\n---\ncuerpo');
    const r = await readSkillTool.execute({ name: 'nope' }, ctx(registry()));
    expect(r).toMatchObject({ ok: false, recoverable: true });
    expect(!r.ok && r.error).toContain('nope');
    expect(!r.ok && r.error).toContain('deploy');
    expect(!r.ok && r.error).toContain('lint');
  });

  it('sin registro: «This session has no skills.»', async () => {
    const r = await readSkillTool.execute({ name: 'x' }, ctx(undefined));
    expect(r).toMatchObject({ ok: false, error: 'This session has no skills.' });
  });

  it('un fichero borrado tras descubrirlo es un error no recuperable', async () => {
    const file = writeSkill('deploy', '---\nname: deploy\ndescription: d\n---\ncuerpo');
    const reg = registry();
    rmSync(file);
    const r = await readSkillTool.execute({ name: 'deploy' }, ctx(reg));
    expect(r).toMatchObject({ ok: false, recoverable: false });
  });

  it('nunca acepta rutas: ni relativas con .. ni absolutas de un fichero existente', async () => {
    writeSkill('deploy', '---\nname: deploy\ndescription: d\n---\ncuerpo');
    const reg = registry();
    for (const name of ['../../etc/passwd', '..\..\secret.txt', secret]) {
      const r = await readSkillTool.execute({ name }, ctx(reg));
      expect(r.ok, name).toBe(false);
      expect(JSON.stringify(r), name).not.toContain('TOP-SECRET-CONTENT');
    }
  });
});
