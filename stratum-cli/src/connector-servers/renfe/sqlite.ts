/**
 * Carga perezosa de `node:sqlite`. Al cargarse emite un `ExperimentalWarning`
 * que ensuciaría el stderr del conector; se filtra solo ese aviso (el resto
 * pasa). Se carga con `require` en el momento de uso, no con un `import`
 * estático: el empaquetador lo elevaría por encima de este código y el aviso
 * saldría antes (y Vite/Vitest no reconocen `node:sqlite` en un `import()`).
 */
import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';

export type { DatabaseSync };

let patched = false;

function quietExperimentalSqlite(): void {
  if (patched) return;
  patched = true;
  const original = process.emitWarning.bind(process);
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const first = rest[0];
    const type =
      typeof first === 'string'
        ? first
        : typeof first === 'object' && first !== null && 'type' in first
          ? String((first as { type: unknown }).type)
          : warning instanceof Error
            ? warning.name
            : 'Warning';
    const message = typeof warning === 'string' ? warning : warning.message;
    if (type === 'ExperimentalWarning' && /SQLite/i.test(message)) return;
    (original as (...a: unknown[]) => void)(warning, ...rest);
  }) as typeof process.emitWarning;
}

export async function loadSqlite(): Promise<typeof import('node:sqlite')> {
  quietExperimentalSqlite();
  return createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
}
