import { defineConfig } from 'tsup';
import { readFileSync } from 'fs';

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8')) as { version: string };

export default defineConfig({
  entry: ['src/cli/index.ts'],
  format: ['esm'],
  target: 'node22',
  clean: true,
  shims: true,
  splitting: false,
  bundle: true,
  // Dependencias opcionales nativas / pesadas: nunca se bundlean. Se resuelven
  // en runtime vía import dinámico y degradan si no están instaladas.
  external: ['@xenova/transformers', 'better-sqlite3', 'sqlite-vec'],
  define: {
    __VERSION__: JSON.stringify(pkg.version),
  },
});
