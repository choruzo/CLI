import { defineConfig } from 'tsup';
import { readFileSync } from 'fs';

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8')) as { version: string };

export default defineConfig([
  {
    entry: ['src/cli/index.ts'],
    format: ['esm'],
    target: 'node22',
    clean: true,
    shims: true,
    splitting: false,
    bundle: true,
    // Dependencias opcionales nativas / pesadas: nunca se bundlean. Se resuelven
    // en runtime vía import dinámico y degradan si no están instaladas.
    // `ssh2` no es opcional, pero resuelve su binding nativo (`cpu-features`,
    // `sshcrypto.node`) con requires dinámicos y degrada a JS puro: bundlearlo
    // rompe esa resolución.
    external: ['@xenova/transformers', 'better-sqlite3', 'sqlite-vec', 'ssh2'],
    define: {
      __VERSION__: JSON.stringify(pkg.version),
    },
  },
  // Conector Open-Meteo (M20): un único .mjs autocontenido (zod incluido) que corre
  // en un contenedor sin node_modules. Nunca importa el runtime de Stratum
  // (lo vigila src/connector-servers/architecture.test.ts).
  {
    entry: { 'open-meteo/server': 'src/connector-servers/open-meteo/server.ts' },
    outDir: 'box-image/connectors',
    format: ['esm'],
    outExtension: () => ({ js: '.mjs' }),
    target: 'node22',
    platform: 'node',
    bundle: true,
    noExternal: [/.*/],
    splitting: false,
    clean: true,
    sourcemap: false,
    dts: false,
  },
]);
