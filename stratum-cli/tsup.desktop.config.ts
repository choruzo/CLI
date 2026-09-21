import { defineConfig } from 'tsup';
import { readFileSync } from 'fs';

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8')) as { version: string };

/**
 * Paquetes que NO van en el blob del SEA: tienen binarios `.node` (o los
 * resuelven con requires dinámicos) y viajan en `<resources>/sidecar/node_modules`.
 * La lista vive en un JSON porque `stratum-desktop/scripts/build-sea.mjs` copia
 * exactamente estos paquetes y su clausura de dependencias.
 */
const RESOURCE_PACKAGES = JSON.parse(
  readFileSync('./src/desktop/resource-packages.json', 'utf-8'),
) as string[];

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/**
 * Bundle del sidecar de Stratum Desktop (`src/desktop-server.ts`), el paso previo
 * al binario Node SEA que genera `stratum-desktop/scripts/build-sea.mjs`.
 *
 * Distinto del bundle de la CLI en lo que exige un SEA en Node 22:
 * - **CommonJS en un único fichero**: el script inyectado no puede ser ESM ni
 *   importar ficheros vecinos, así que todo lo que no sea nativo se incrusta.
 * - **Externals resueltos fuera del blob**: los `RESOURCE_PACKAGES` viajan en los
 *   resources de Tauri. Los que se importan de forma dinámica pasan por
 *   `runtime/optional-import.ts` (lo instala `desktop/natives.ts`); los que se
 *   importan de forma estática (`ssh2`), por el `require` del banner.
 */
export default defineConfig({
  entry: { 'stratum-core': 'src/desktop-server.ts' },
  outDir: 'dist-desktop',
  format: ['cjs'],
  target: 'node22',
  platform: 'node',
  clean: true,
  shims: true,
  splitting: false,
  bundle: true,
  // Una sola lista, porque `noExternal` gana a `external` en tsup.
  noExternal: [new RegExp(`^(?!(${RESOURCE_PACKAGES.map(escapeRegExp).join('|')})(/|$))`)],
  external: RESOURCE_PACKAGES,
  // En un SEA, el `require` que recibe el script solo resuelve módulos internos
  // de Node. El banner lo sustituye por uno que resuelve desde los resources de
  // Tauri. Fuera de un SEA (el bundle ejecutado con `node`) se deja el normal.
  banner: {
    js: [
      'var require = (function (base) {',
      '  try {',
      "    var sea = process.getBuiltinModule && process.getBuiltinModule('node:sea');",
      '    var dir = process.env.STRATUM_RESOURCES_DIR;',
      '    if (sea && sea.isSea() && dir) {',
      "      return process.getBuiltinModule('node:module').createRequire(dir + '/sidecar/index.cjs');",
      '    }',
      '  } catch (e) {}',
      '  return base;',
      '})(require);',
    ].join('\n'),
  },
  define: {
    __VERSION__: JSON.stringify(pkg.version),
  },
});
