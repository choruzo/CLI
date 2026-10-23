import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  appendFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  SkillRegistry,
  bundledSkillsDir,
  buildSkillsBlock,
  parseSkill,
  skillDirs,
  type SkillEntry,
} from './registry.js';

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
    const reg = new SkillRegistry([root], { home, builtinDir: null });
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
    const reg = new SkillRegistry([root], { home, builtinDir: null });
    expect(reg.entries.map((e) => e.name)).toEqual(['lint']);
    expect(reg.entries[0]!.scope).toBe('user');
  });

  it('precedencia: proyecto gana a usuario, y .stratum gana a .claude', () => {
    writeSkill(home, '.stratum/skills', 'review', '---\nname: review\ndescription: usuario\n---');
    writeSkill(root, '.claude/skills', 'review', '---\nname: review\ndescription: claude\n---');
    writeSkill(root, '.stratum/skills', 'review', '---\nname: review\ndescription: stratum\n---');
    const reg = new SkillRegistry([root], { home, builtinDir: null });
    expect(reg.entries).toHaveLength(1);
    expect(reg.entries[0]!.description).toBe('stratum');
  });

  it('roots duplicados se escanean una sola vez', () => {
    const dirs = skillDirs([root, root], home);
    expect(new Set(dirs.map((d) => d.dir)).size).toBe(dirs.length);
  });

  it('sin frontmatter name, el nombre sale del directorio', () => {
    writeSkill(root, '.stratum/skills', 'Migraciones', 'Cuerpo sin frontmatter');
    const reg = new SkillRegistry([root], { home, builtinDir: null });
    expect(reg.entries[0]!.name).toBe('migraciones');
    expect(reg.entries[0]!.description).toBe('');
  });

  it('acepta también <dir>/<n>.md suelto e ignora README.md', () => {
    const dir = join(root, '.stratum/skills');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'suelta.md'), '---\nname: suelta\ndescription: d\n---', 'utf-8');
    writeFileSync(join(dir, 'README.md'), '# no soy una skill', 'utf-8');
    const reg = new SkillRegistry([root], { home, builtinDir: null });
    expect(reg.entries.map((e) => e.name)).toEqual(['suelta']);
  });

  it('una description plegada (YAML >) se colapsa a una línea', () => {
    writeSkill(
      root,
      '.stratum/skills',
      'largo',
      '---\nname: largo\ndescription: >\n  Primera línea\n  y su continuación\n---\ncuerpo',
    );
    const reg = new SkillRegistry([root], { home, builtinDir: null });
    expect(reg.entries[0]!.description).toBe('Primera línea y su continuación');
  });
});

describe('SkillRegistry — índice materializado', () => {
  it('escribe la tabla con su fingerprint', () => {
    writeSkill(root, '.stratum/skills', 'deploy', '---\nname: deploy\ndescription: d\n---');
    const reg = new SkillRegistry([root], { home, builtinDir: null });
    const target = join(root, '.stratum', 'skill-registry.md');
    expect(reg.writeRegistryFile(target)).toBe(target);
    const content = readFileSync(target, 'utf-8');
    expect(content).toContain(`fingerprint: ${reg.fingerprint}`);
    expect(content).toContain('| deploy |');
  });

  it('no reescribe si el fingerprint no cambió (caché)', () => {
    writeSkill(root, '.stratum/skills', 'deploy', '---\nname: deploy\ndescription: d\n---');
    const target = join(root, '.stratum', 'skill-registry.md');
    new SkillRegistry([root], { home, builtinDir: null }).writeRegistryFile(target);
    appendFileSync(target, '\nMARCA\n', 'utf-8');

    new SkillRegistry([root], { home, builtinDir: null }).writeRegistryFile(target);
    expect(readFileSync(target, 'utf-8')).toContain('MARCA');
  });

  it('reescribe cuando cambia el contenido de una skill', () => {
    writeSkill(root, '.stratum/skills', 'deploy', '---\nname: deploy\ndescription: vieja\n---');
    const target = join(root, '.stratum', 'skill-registry.md');
    new SkillRegistry([root], { home, builtinDir: null }).writeRegistryFile(target);

    writeSkill(root, '.stratum/skills', 'deploy', '---\nname: deploy\ndescription: nueva\n---');
    new SkillRegistry([root], { home, builtinDir: null }).writeRegistryFile(target);
    expect(readFileSync(target, 'utf-8')).toContain('nueva');
  });

  it('sin skills no crea el fichero', () => {
    const target = join(root, '.stratum', 'skill-registry.md');
    expect(
      new SkillRegistry([root], { home, builtinDir: null }).writeRegistryFile(target),
    ).toBeNull();
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
    const block = buildSkillsBlock([entry]);
    expect(block).toContain('# Skills');
    expect(block).toContain('read_skill');
    expect(block).toContain('usa a \\| b');
    expect(block).not.toContain('CUERPO SECRETO');
    // Sin rutas: la skill se carga por su nombre con read_skill.
    expect(block).not.toContain('SKILL.md');
    expect(block).not.toContain('.stratum/skills');
  });
});

describe('SkillRegistry — de serie, presets y ámbitos (contrato builtin)', () => {
  let builtin: string;

  beforeEach(() => {
    builtin = join(root, '..', 'builtin');
    mkdirSync(builtin, { recursive: true });
  });

  const fm = (name: string, extra = ''): string =>
    `---\nname: ${name}\ndescription: d ${name}\n${extra}---\ncuerpo`;

  function names(opts: ConstructorParameters<typeof SkillRegistry>[1]): string[] {
    return new SkillRegistry([root], { home, builtinDir: builtin, ...opts }).entries
      .map((e) => e.name)
      .sort();
  }

  it('una skill de proyecto o de usuario con el mismo nombre sustituye a la de serie', () => {
    writeSkill(builtin, '.', 'same', fm('same'));
    writeSkill(builtin, '.', 'other', fm('other'));
    expect(new SkillRegistry([root], { home, builtinDir: builtin }).resolve('same')?.scope).toBe(
      'builtin',
    );

    writeSkill(home, '.stratum/skills', 'same', fm('same'));
    expect(new SkillRegistry([root], { home, builtinDir: builtin }).resolve('same')?.scope).toBe(
      'user',
    );

    writeSkill(root, '.stratum/skills', 'same', fm('same'));
    const reg = new SkillRegistry([root], { home, builtinDir: builtin });
    expect(reg.resolve('same')?.scope).toBe('project');
    expect(reg.resolve('other')?.scope).toBe('builtin');
  });

  it('filtra por preset: sin presets, coding; assistant solo las que lo declaran', () => {
    writeSkill(builtin, '.', 'a-only', fm('a-only', 'presets: [assistant]\n'));
    writeSkill(builtin, '.', 'both', fm('both', 'presets: [coding, assistant]\n'));
    writeSkill(builtin, '.', 'plain', fm('plain'));
    writeSkill(builtin, '.', 'scalar', fm('scalar', 'presets: assistant\n'));
    writeSkill(builtin, '.', 'unknown', fm('unknown', 'presets: [robot]\n'));
    expect(names({ preset: 'coding' })).toEqual(['both', 'plain', 'unknown']);
    expect(names({ preset: 'assistant' })).toEqual(['a-only', 'both', 'scalar']);
  });

  it('builtin: false no carga ninguna de serie; una lista, solo esas', () => {
    writeSkill(builtin, '.', 'x', fm('x'));
    writeSkill(builtin, '.', 'y', fm('y'));
    expect(names({ builtin: false })).toEqual([]);
    expect(names({ builtin: ['x'] })).toEqual(['x']);
    expect(names({ builtin: true })).toEqual(['x', 'y']);
  });

  it('builtin: [x] no filtra las de usuario o proyecto', () => {
    writeSkill(builtin, '.', 'x', fm('x'));
    writeSkill(builtin, '.', 'y', fm('y'));
    writeSkill(root, '.stratum/skills', 'mine', fm('mine'));
    expect(names({ builtin: ['x'] })).toEqual(['mine', 'x']);
  });

  it('userAndProject: false ignora usuario y proyecto', () => {
    writeSkill(builtin, '.', 'x', fm('x'));
    writeSkill(root, '.stratum/skills', 'mine', fm('mine'));
    writeSkill(home, '.stratum/skills', 'theirs', fm('theirs'));
    expect(names({ userAndProject: false })).toEqual(['x']);
  });

  it('writeRegistryFile no escribe con solo skills de serie y sí con una de proyecto', () => {
    writeSkill(builtin, '.', 'x', fm('x'));
    const target = join(root, '.stratum', 'skill-registry.md');
    expect(
      new SkillRegistry([root], { home, builtinDir: builtin }).writeRegistryFile(target),
    ).toBeNull();
    expect(existsSync(target)).toBe(false);

    writeSkill(root, '.stratum/skills', 'mine', fm('mine'));
    expect(new SkillRegistry([root], { home, builtinDir: builtin }).writeRegistryFile(target)).toBe(
      target,
    );
  });

  it('bundledSkillsDir encuentra stratum-cli/skills y sus tres skills reales parsean', () => {
    const dir = bundledSkillsDir();
    expect(dir).not.toBeNull();
    expect(existsSync(join(dir!, '.stratum-builtin-skills'))).toBe(true);
    const all = new Map<string, SkillEntry>();
    for (const preset of ['coding', 'assistant'] as const) {
      const reg = new SkillRegistry([], { home, preset, userAndProject: false });
      for (const e of reg.entries) all.set(e.name, e);
    }
    const expected: Record<string, string[]> = {
      'stratum-project-memory': ['coding'],
      'stratum-global-memory': ['assistant'],
      'stratum-skill-authoring': ['coding', 'assistant'],
    };
    for (const [name, presets] of Object.entries(expected)) {
      const e = all.get(name);
      expect(e, name).toBeDefined();
      expect(e!.description.length).toBeGreaterThan(0);
      expect(e!.scope).toBe('builtin');
      expect(e!.presets).toEqual(presets);
    }
  });
});
