/**
 * Los conectores se empaquetan en un único .mjs que corre en un contenedor sin
 * node_modules: nunca pueden importar el runtime de Stratum. Solo se admiten
 * rutas relativas que queden dentro de `src/connector-servers/`, builtins de
 * Node (`node:*`) y `zod`.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sources(p);
    return p.endsWith('.ts') && !p.endsWith('.test.ts') ? [p] : [];
  });
}

function specifiers(code: string): string[] {
  const out: string[] = [];
  const re = /(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)['"]([^'"]+)['"]/g;
  for (let m = re.exec(code); m; m = re.exec(code)) out.push(m[1]!);
  return out;
}

function allowed(file: string, spec: string): boolean {
  if (spec.startsWith('.')) {
    const target = resolve(dirname(file), spec);
    return target === ROOT || target.startsWith(ROOT + sep);
  }
  if (spec === 'zod') return true;
  if (spec.startsWith('node:')) return true;
  return builtinModules.includes(spec);
}

describe('connector-servers: imports autocontenidos', () => {
  const files = sources(ROOT);

  it('hay fuentes que comprobar', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files.map((f) => [relative(ROOT, f), f] as const))('%s', (_name, file) => {
    const bad = specifiers(readFileSync(file, 'utf8')).filter((s) => !allowed(file, s));
    expect(bad).toEqual([]);
  });
});
