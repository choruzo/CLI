import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SkillRegistry, buildSkillsBlock, parseSkill, skillDirs } from './registry.js';

let root: string;
let home: string;

function writeSkill(base: string, dir: string, name: string, content: string): string {
  const target = join(base, dir, name);
  mkdirSync(target, { recursive: true });
  const file = join(target, 'SKILL.md');
  writeFileSync(file, content, 'utf-8');
  return file;
}

beforeEach(() => {
  const tmp = mkdtempSync(join(tmpdir(), 'stratum-skills-'));
  root = join(tmp, 'project');
  home = join(tmp, 'home');
  mkdirSync(root, { recursive: true });
  mkdirSync(home, { recursive: true });
});

afterEach(() => {
  rmSync(join(root, '..'), { recursive: true, force: true });
});

describe('SkillRegistry — descubrimiento (Hito 12)', () => {
  it('descubre <root>/.stratum/skills/<n>/SKILL.md con nombre y trigger', () => {
    writeSkill(
      root,
      '.stratum/skills',
      'deploy',
      '---\nname: deploy\ndescription: Publicar una release en npm\n---\nPasos...',
    );
    const reg = new SkillRegistry([root], { home });
    expect(reg.entries).toHaveLength(1);
    expect(reg.entries[0]!.name).toBe('deploy');
    expect(reg.entries[0]!.description).toBe('Publicar una release en npm');
    expect(reg.entries[0]!.scope).toBe('project');
    expect(reg.entries[0]!.source).toBe('.stratum/skills');
  });

  it('escanea también .claude/skills como cortesía', () => {
    writeSkill(
      home,
      '.claude/skills',
      'lint',
      '---\nname: lint\ndescription: Pasar el linter\n---',
    );
    const reg = new SkillRegistry([root], { home });
    expect(reg.entries.map((e) => e.name)).toEqual(['lint']);
    expect(reg.entries[0]!.scope).toBe('user');
  });

  it('precedencia: proyecto gana a usuario, y .stratum gana a .claude', () => {
    writeSkill(home, '.stratum/skills', 'review', '---\nname: review\ndescription: usuario\n---');
    writeSkill(root, '.claude/skills', 'review', '---\nname: review\ndescription: claude\n---');
    writeSkill(root, '.stratum/skills', 'review', '---\nname: review\ndescription: stratum\n---');
    const reg = new SkillRegistry([root], { home });
    expect(reg.entries).toHaveLength(1);
    expect(reg.entries[0]!.description).toBe('stratum');
  });

  it('roots duplicados se escanean una sola vez', () => {
    const dirs = skillDirs([root, root], home);
    expect(new Set(dirs.map((d) => d.dir)).size).toBe(dirs.length);
  });

  it('sin frontmatter name, el nombre sale del directorio', () => {
    writeSkill(root, '.stratum/skills', 'Migraciones', 'Cuerpo sin frontmatter');
    const reg = new SkillRegistry([root], { home });
    expect(reg.entries[0]!.name).toBe('migraciones');
    expect(reg.entries[0]!.description).toBe('');
  });

  it('acepta también <dir>/<n>.md suelto e ignora README.md', () => {
    const dir = join(root, '.stratum/skills');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'suelta.md'), '---\nname: suelta\ndescription: d\n---', 'utf-8');
    writeFileSync(join(dir, 'README.md'), '# no soy una skill', 'utf-8');
    const reg = new SkillRegistry([root], { home });
    expect(reg.entries.map((e) => e.name)).toEqual(['suelta']);
  });

  it('una description plegada (YAML >) se colapsa a una línea', () => {
    writeSkill(
      root,
      '.stratum/skills',
      'largo',
      '---\nname: largo\ndescription: >\n  Primera línea\n  y su continuación\n---\ncuerpo',
    );
    const reg = new SkillRegistry([root], { home });
    expect(reg.entries[0]!.description).toBe('Primera línea y su continuación');
  });
});

describe('SkillRegistry — índice materializado', () => {
  it('escribe la tabla con su fingerprint', () => {
    writeSkill(root, '.stratum/skills', 'deploy', '---\nname: deploy\ndescription: d\n---');
    const reg = new SkillRegistry([root], { home });
    const target = join(root, '.stratum', 'skill-registry.md');
    expect(reg.writeRegistryFile(target)).toBe(target);
    const content = readFileSync(target, 'utf-8');
    expect(content).toContain(`fingerprint: ${reg.fingerprint}`);
    expect(content).toContain('| deploy |');
  });

  it('no reescribe si el fingerprint no cambió (caché)', () => {
    writeSkill(root, '.stratum/skills', 'deploy', '---\nname: deploy\ndescription: d\n---');
    const target = join(root, '.stratum', 'skill-registry.md');
    new SkillRegistry([root], { home }).writeRegistryFile(target);
    appendFileSync(target, '\nMARCA\n', 'utf-8');

    new SkillRegistry([root], { home }).writeRegistryFile(target);
    expect(readFileSync(target, 'utf-8')).toContain('MARCA');
  });

  it('reescribe cuando cambia el contenido de una skill', () => {
    writeSkill(root, '.stratum/skills', 'deploy', '---\nname: deploy\ndescription: vieja\n---');
    const target = join(root, '.stratum', 'skill-registry.md');
    new SkillRegistry([root], { home }).writeRegistryFile(target);

    writeSkill(root, '.stratum/skills', 'deploy', '---\nname: deploy\ndescription: nueva\n---');
    new SkillRegistry([root], { home }).writeRegistryFile(target);
    expect(readFileSync(target, 'utf-8')).toContain('nueva');
  });

  it('sin skills no crea el fichero', () => {
    const target = join(root, '.stratum', 'skill-registry.md');
    expect(new SkillRegistry([root], { home }).writeRegistryFile(target)).toBeNull();
  });
});

describe('buildSkillsBlock', () => {
  it('sin skills devuelve cadena vacía (no se inyecta nada)', () => {
    expect(buildSkillsBlock([])).toBe('');
  });

  it('renderiza índice, no cuerpos, y escapa el pipe', () => {
    const entry = parseSkill(
      join(root, '.stratum/skills/x/SKILL.md'),
      '---\nname: x\ndescription: usa a | b\n---\nCUERPO SECRETO',
      'project',
      '.stratum/skills',
    )!;
    const block = buildSkillsBlock([entry], root);
    expect(block).toContain('# Skills');
    expect(block).toContain('read_file');
    expect(block).toContain('usa a \\| b');
    expect(block).not.toContain('CUERPO SECRETO');
    // Ruta relativa al cwd: utilizable tal cual por read_file.
    expect(block).toContain('.stratum/skills/x/SKILL.md');
  });
});
