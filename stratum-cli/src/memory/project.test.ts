import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { loadProjectMemory } from './project.js';
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
    const mem = loadProjectMemory(config);
    expect(mem.projectContent).toBe('');
    expect(mem.globalContent).toBe('');
  });

  it('carga el STRATUM.md del proyecto cuando existe', () => {
    writeFileSync(join(tmpDir, 'STRATUM.md'), '# Mi Proyecto\n\nContenido de prueba.', 'utf-8');
    const config = StratumConfigSchema.parse({});
    const mem = loadProjectMemory(config);
    expect(mem.projectContent).toContain('Mi Proyecto');
    expect(mem.projectPath).toContain('STRATUM.md');
  });

  it('devuelve la ruta correcta aunque el archivo no exista', () => {
    const config = StratumConfigSchema.parse({});
    const mem = loadProjectMemory(config);
    expect(mem.projectPath).toContain('STRATUM.md');
  });

  it('trim del contenido cargado', () => {
    writeFileSync(join(tmpDir, 'STRATUM.md'), '  \n# Título\n  ', 'utf-8');
    const config = StratumConfigSchema.parse({});
    const mem = loadProjectMemory(config);
    expect(mem.projectContent).toBe('# Título');
  });
});
