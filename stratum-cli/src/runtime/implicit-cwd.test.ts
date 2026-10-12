import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { dirname, join, relative } from 'path';
import { fileURLToPath } from 'url';

/**
 * Test de arquitectura (M0 del PRD de Stratum Dot): fuera de `cli/`, una
 * sesión no puede depender del directorio del proceso. El `cwd` llega por
 * `SessionEnv`, y el único sitio que consulta el del proceso es
 * `runtime/session-env.ts`.
 *
 * La lista de excepciones es cerrada y cada entrada dice por qué no es
 * composición de una sesión. Añadir una exige justificarla aquí.
 */
const ALLOWED: Record<string, string> = {
  'runtime/session-env.ts': 'el único punto que lee el entorno del proceso',
  'config/loader.ts':
    'default de `loadConfig(startDir?)`: API de borde; un anfitrión pasa `env.cwd`',
  'config/writer.ts': 'defaults de los comandos `config`/`provider` de la CLI',
  'eval/runner.ts': 'orquestador de `stratum eval`: lanza la CLI como proceso hijo',
  'tools/fs/glob.ts': 'texto de la descripción de un parámetro, no una llamada',
  'tools/ssh/ssh-test-utils.ts': 'utilidad de tests',
};

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe('cwd implícito', () => {
  const offenders = sourceFiles(SRC)
    .map((file) => relative(SRC, file).replace(/\\/g, '/'))
    .filter((rel) => !rel.startsWith('cli/'))
    .filter((rel) => readFileSync(join(SRC, rel), 'utf-8').includes('process.cwd()'));

  it('nada fuera de cli/ consulta process.cwd(), salvo las excepciones declaradas', () => {
    expect(offenders.filter((rel) => !(rel in ALLOWED))).toEqual([]);
  });

  it('la lista de excepciones no tiene entradas muertas', () => {
    expect(Object.keys(ALLOWED).filter((rel) => !offenders.includes(rel))).toEqual([]);
  });
});
