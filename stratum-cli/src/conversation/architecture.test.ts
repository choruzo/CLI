import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { dirname, join, relative } from 'path';
import { fileURLToPath } from 'url';

/**
 * Reglas de la memoria de sesión (M11), comprobadas sobre el código fuente:
 *
 *  1. **No es autoridad.** Nada que decida permisos, aprobaciones, entornos,
 *     guardas o la ejecución de tools la importa: la memoria de sesión es
 *     contexto derivado para el modelo, nunca una entrada de una decisión.
 *  2. **No se promociona sola.** `src/conversation/` no escribe en la memoria
 *     de proyecto ni en la global (`src/memory/`: `decisions.json`,
 *     `STRATUM.md`, vectores).
 *  3. **No viaja por el log.** Sus llamadas a `log.*` no llevan el texto de la
 *     memoria ni de la conversación: solo recuentos, ids y motivos.
 */

const src = join(dirname(fileURLToPath(import.meta.url)), '..');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return walk(path);
    return path.endsWith('.ts') && !path.endsWith('.test.ts') ? [path] : [];
  });
}

function imports(text: string): string[] {
  return [...text.matchAll(/(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]!);
}

const read = (path: string): string => readFileSync(path, 'utf-8');
const rel = (path: string): string => relative(src, path).replace(/\\/g, '/');

/** Lo que decide qué se puede hacer: no puede depender de la memoria de sesión. */
const AUTHORITY = [
  ...walk(join(src, 'tools')),
  ...walk(join(src, 'security')),
  join(src, 'host', 'interactions.ts'),
  join(src, 'daemon', 'approval-center.ts'),
  join(src, 'daemon', 'authorize.ts'),
  join(src, 'daemon', 'approver-key.ts'),
  join(src, 'agent', 'session-profile.ts'),
  join(src, 'agent', 'profiles.ts'),
  join(src, 'agent', 'risk.ts'),
];

describe('memoria de sesión — reglas de arquitectura (M11)', () => {
  it('ningún módulo que decide permisos, aprobaciones o guardas la importa', () => {
    expect(AUTHORITY.length).toBeGreaterThan(20);
    for (const file of AUTHORITY) {
      for (const spec of imports(read(file))) {
        expect(spec.includes('conversation/'), `${rel(file)} importa ${spec}`).toBe(false);
        expect(spec.endsWith('context-builder.js'), `${rel(file)} importa ${spec}`).toBe(false);
      }
    }
  });

  it('src/conversation/ no toca la memoria de proyecto ni la global', () => {
    const files = walk(join(src, 'conversation'));
    expect(files.length).toBeGreaterThan(5);
    for (const file of files) {
      for (const spec of imports(read(file))) {
        expect(spec.includes('/memory/'), `${rel(file)} importa ${spec}`).toBe(false);
      }
      expect(read(file)).not.toMatch(/decisions\.json'|STRATUM\.md'/);
    }
  });

  it('sus logs no llevan la memoria ni la conversación', () => {
    for (const file of [
      ...walk(join(src, 'conversation')),
      join(src, 'daemon', 'session-archive.ts'),
    ]) {
      const text = read(file);
      for (const call of text.matchAll(/log\.(?:debug|info|warn|error)\(([\s\S]*?)\);/g)) {
        expect(call[1], `${rel(file)}: ${call[0].slice(0, 80)}`).not.toMatch(
          /\b(?:memory|summary|content|text|prompt|messages|chunk|items)\b(?!\w*:)/,
        );
      }
    }
  });
});
