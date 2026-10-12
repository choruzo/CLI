import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { builtinModules } from 'module';
import { dirname, join, relative, resolve } from 'path';
import { fileURLToPath } from 'url';

/**
 * Test de arquitectura: `src/protocol/` es puro. Lo importa código que no es
 * Node (un webview), y ahí un `import` que alcance —aunque sea de forma
 * transitiva— un módulo de Node deja la aplicación en blanco sin que `tsc` ni
 * los tests de la CLI lo noten.
 *
 * Reglas:
 *  - los módulos puros (todo menos `schemas.ts`) solo importan ficheros de
 *    `src/protocol/`: ningún paquete, ningún built-in, nada del runtime;
 *  - `schemas.ts` puede importar además `zod`, y nada más;
 *  - ningún módulo usa globales de Node.
 */

const PROTOCOL_DIR = dirname(fileURLToPath(import.meta.url));
const SCHEMAS = 'schemas.ts';
const NODE_BUILTINS = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));
const NODE_GLOBALS = /\b(process|Buffer|__dirname|__filename|require)\b\s*[.([]/;

function sources(): string[] {
  return readdirSync(PROTOCOL_DIR).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
}

/** Especificadores de `import`/`export … from` de un fichero (también los de solo tipos). */
function specifiers(file: string): string[] {
  const text = readFileSync(file, 'utf-8');
  const out: string[] = [];
  const re = /(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\sfrom\s+)?['"]([^'"]+)['"]/g;
  for (let m = re.exec(text); m; m = re.exec(text)) out.push(m[1]!);
  const dynamic = /import\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (let m = dynamic.exec(text); m; m = dynamic.exec(text)) out.push(m[1]!);
  return out;
}

function resolveLocal(from: string, spec: string): string {
  return resolve(dirname(from), spec.replace(/\.js$/, '.ts'));
}

/** Cierre transitivo de imports desde `entry`: ficheros locales y paquetes externos. */
function closure(entry: string): { files: Set<string>; external: Set<string> } {
  const files = new Set<string>();
  const external = new Set<string>();
  const pending = [entry];
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (files.has(file)) continue;
    files.add(file);
    for (const spec of specifiers(file)) {
      if (!spec.startsWith('.')) {
        external.add(spec);
        continue;
      }
      const target = resolveLocal(file, spec);
      expect(existsSync(target), `${spec} (desde ${relative(PROTOCOL_DIR, file)})`).toBe(true);
      pending.push(target);
    }
  }
  return { files, external };
}

const rel = (files: Iterable<string>): string[] =>
  [...files].map((f) => relative(PROTOCOL_DIR, f).replace(/\\/g, '/')).sort();

describe('pureza de src/protocol/', () => {
  const pure = sources().filter((f) => f !== SCHEMAS);

  it('hay módulos que comprobar, y el punto de entrada los reúne', () => {
    expect(pure).toContain('index.ts');
    expect(pure.length).toBeGreaterThan(4);
    const fromIndex = rel(closure(join(PROTOCOL_DIR, 'index.ts')).files);
    expect(fromIndex).toEqual([...pure].sort());
  });

  it.each(pure)('%s no alcanza nada fuera del protocolo, ni de forma transitiva', (name) => {
    const { files, external } = closure(join(PROTOCOL_DIR, name));
    expect([...external]).toEqual([]);
    expect(rel(files).filter((f) => f.startsWith('..'))).toEqual([]);
    expect(rel(files)).not.toContain(SCHEMAS);
  });

  it('ningún módulo importa un built-in de Node ni usa sus globales', () => {
    for (const name of sources()) {
      const file = join(PROTOCOL_DIR, name);
      const { external } = closure(file);
      expect(
        [...external].filter((s) => NODE_BUILTINS.has(s)),
        name,
      ).toEqual([]);
      const code = readFileSync(file, 'utf-8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      expect(NODE_GLOBALS.test(code), `${name} usa un global de Node`).toBe(false);
    }
  });
});
