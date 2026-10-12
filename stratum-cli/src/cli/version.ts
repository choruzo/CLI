import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Inyectada por tsup al compilar; en desarrollo (tsx) se lee de package.json.
declare const __VERSION__: string;

/** Versión de la CLI que se está ejecutando. */
export function cliVersion(): string {
  if (typeof __VERSION__ !== 'undefined') return __VERSION__;
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const pkg = JSON.parse(readFileSync(join(thisDir, '..', '..', 'package.json'), 'utf-8')) as {
    version: string;
  };
  return pkg.version;
}
