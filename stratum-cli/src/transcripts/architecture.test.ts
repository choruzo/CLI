import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { dirname, join, relative } from 'path';
import { fileURLToPath } from 'url';

/**
 * Reglas de la búsqueda en conversaciones (M19 fase 3), sobre el código fuente:
 *
 *  1. **Solo lectura.** Cada apertura de una conversación es `readOnly: true`
 *     y nada llama a los métodos que escriben el store.
 *  2. **Sin promoción.** `src/transcripts/` no importa `src/memory/`: lo leído
 *     no pasa solo a `decisions.json` ni a `STRATUM.md`.
 *  3. **No es autoridad.** Nada que decide permisos, aprobaciones o guardas la
 *     importa (como la memoria de sesión, M11).
 *  4. **No viaja por el log.** Sus `log.*` no llevan texto de conversaciones.
 */

const src = join(dirname(fileURLToPath(import.meta.url)), '..');
const own = join(src, 'transcripts');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return walk(path);
    return path.endsWith('.ts') && !path.endsWith('.test.ts') ? [path] : [];
  });
}
const read = (p: string): string => readFileSync(p, 'utf-8');
const rel = (p: string): string => relative(src, p).replace(/\\/g, '/');
const imports = (text: string): string[] =>
  [...text.matchAll(/(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]!);

describe('búsqueda en conversaciones — reglas de arquitectura (M19 fase 3)', () => {
  const files = walk(own);

  it('abre siempre en solo lectura y nunca escribe el store', () => {
    expect(files.length).toBeGreaterThan(1);
    for (const file of files) {
      const text = read(file);
      for (const m of text.matchAll(/FileConversationStore\.open\(([^)]*)\)/g)) {
        expect(m[1], rel(file)).toMatch(/readOnly:\s*true/);
      }
      expect(text, rel(file)).not.toMatch(
        /\.(putChat|appendAgent|amendAgent)\(|writeFile|appendFile/,
      );
    }
  });

  it('no importa la memoria de decisiones', () => {
    for (const file of files) {
      for (const spec of imports(read(file))) {
        expect(/(^|\/)memory\//.test(spec), `${rel(file)} importa ${spec}`).toBe(false);
      }
    }
  });

  it('nada que decida permisos, aprobaciones o guardas la importa', () => {
    const authority = [
      ...walk(join(src, 'tools')),
      ...walk(join(src, 'security')),
      join(src, 'host', 'interactions.ts'),
      join(src, 'daemon', 'approval-center.ts'),
      join(src, 'daemon', 'authorize.ts'),
      join(src, 'agent', 'session-profile.ts'),
      join(src, 'agent', 'risk.ts'),
    ];
    for (const file of authority) {
      for (const spec of imports(read(file))) {
        expect(spec.includes('transcripts/'), `${rel(file)} importa ${spec}`).toBe(false);
      }
    }
  });

  it('sus llamadas a log no llevan texto de conversación', () => {
    for (const file of files) {
      for (const m of read(file).matchAll(/log\.(?:info|warn|error|debug)\(([^)]*)\)/g)) {
        expect(m[1], rel(file)).not.toMatch(/snippet|text|message|query/i);
      }
    }
  });
});
