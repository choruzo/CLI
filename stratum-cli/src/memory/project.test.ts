import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { loadProjectMemory } from './project.js';
import { MemoryManager } from './manager.js';
import { StratumConfigSchema } from '../config/schema.js';

function makeTmpDir(): string {
  const dir = join(tmpdir(), `stratum-test-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('loadProjectMemory', () => {
  let tmpDir: string;
  let originalCwd: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    originalCwd = process.cwd();
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('devuelve strings vacíos cuando no hay ningún STRATUM.md', () => {
    const config = StratumConfigSchema.parse({});
    const mem = loadProjectMemory(config, process.cwd());
    expect(mem.projectContent).toBe('');
    expect(mem.globalContent).toBe('');
  });

  it('carga el STRATUM.md del proyecto cuando existe', () => {
    writeFileSync(join(tmpDir, 'STRATUM.md'), '# Mi Proyecto\n\nContenido de prueba.', 'utf-8');
    const config = StratumConfigSchema.parse({});
    const mem = loadProjectMemory(config, process.cwd());
    expect(mem.projectContent).toContain('Mi Proyecto');
    expect(mem.projectPath).toContain('STRATUM.md');
  });

  it('devuelve la ruta correcta aunque el archivo no exista', () => {
    const config = StratumConfigSchema.parse({});
    const mem = loadProjectMemory(config, process.cwd());
    expect(mem.projectPath).toContain('STRATUM.md');
  });

  it('trim del contenido cargado', () => {
    writeFileSync(join(tmpDir, 'STRATUM.md'), '  \n# Título\n  ', 'utf-8');
    const config = StratumConfigSchema.parse({});
    const mem = loadProjectMemory(config, process.cwd());
    expect(mem.projectContent).toBe('# Título');
  });

  it("con scope 'global' carga el STRATUM.md global desde la ruta configurada", () => {
    const globalPath = join(tmpDir, 'global-STRATUM.md');
    writeFileSync(globalPath, '# Global\n\nConvenciones globales.', 'utf-8');
    const config = StratumConfigSchema.parse({ memory: { globalFile: globalPath } });
    const mem = loadProjectMemory(config, process.cwd(), 'global');
    expect(mem.globalContent).toContain('Convenciones globales');
    expect(mem.globalPath).toBe(globalPath);
  });

  it("con scope 'project' (por defecto) el global queda vacío aunque exista", () => {
    const globalPath = join(tmpDir, 'global-STRATUM.md');
    writeFileSync(globalPath, '# Global', 'utf-8');
    const config = StratumConfigSchema.parse({ memory: { globalFile: globalPath } });
    expect(loadProjectMemory(config, process.cwd()).globalContent).toBe('');
    expect(loadProjectMemory(config, process.cwd(), 'project').globalContent).toBe('');
  });

  it('ninguna combinación carga global y proyecto a la vez', () => {
    writeFileSync(join(tmpDir, 'STRATUM.md'), '# Proyecto', 'utf-8');
    const globalPath = join(tmpDir, 'global-STRATUM.md');
    writeFileSync(globalPath, '# Global', 'utf-8');
    const config = StratumConfigSchema.parse({ memory: { globalFile: globalPath } });
    const project = loadProjectMemory(config, process.cwd(), 'project');
    expect(project.projectContent).toBe('# Proyecto');
    expect(project.globalContent).toBe('');
    const global = loadProjectMemory(config, process.cwd(), 'global');
    expect(global.projectContent).toBe('');
    expect(global.globalContent).toBe('# Global');
  });
});

describe('MemoryManager.getInjectableMemory', () => {
  let tmpDir: string;
  let originalCwd: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    originalCwd = process.cwd();
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("scope 'project' inyecta solo el proyecto; 'global' solo el global", () => {
    writeFileSync(join(tmpDir, 'STRATUM.md'), '# Proyecto', 'utf-8');
    const globalPath = join(tmpDir, 'global-STRATUM.md');
    writeFileSync(globalPath, '# Global', 'utf-8');
    const config = StratumConfigSchema.parse({ memory: { globalFile: globalPath } });

    const project = new MemoryManager(config, process.cwd());
    expect(project.getInjectableMemory()).toBe('# Proyecto');
    expect(project.hasMemory()).toBe(true);

    const global = new MemoryManager(config, process.cwd(), 'global');
    expect(global.getInjectableMemory()).toBe('# Global');
    expect(global.hasMemory()).toBe(true);
  });

  it('devuelve solo una capa cuando la otra no existe', () => {
    writeFileSync(join(tmpDir, 'STRATUM.md'), '# Solo proyecto', 'utf-8');
    const config = StratumConfigSchema.parse({});
    const manager = new MemoryManager(config, process.cwd());
    expect(manager.getInjectableMemory()).toBe('# Solo proyecto');
  });

  it('devuelve string vacío y hasMemory() false sin ninguna capa', () => {
    const config = StratumConfigSchema.parse({});
    const manager = new MemoryManager(config, process.cwd());
    expect(manager.getInjectableMemory()).toBe('');
    expect(manager.hasMemory()).toBe(false);
  });

  it('reload() recoge cambios en disco (caso /init)', () => {
    const config = StratumConfigSchema.parse({});
    const manager = new MemoryManager(config, process.cwd());
    expect(manager.hasMemory()).toBe(false);

    writeFileSync(join(tmpDir, 'STRATUM.md'), '# Generado por init', 'utf-8');
    manager.reload();
    expect(manager.getInjectableMemory()).toBe('# Generado por init');
  });
});
