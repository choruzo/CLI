import { defineConfig } from 'tsup';
import { readFileSync } from 'fs';

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8')) as { version: string };

export default defineConfig({
  entry: ['src/cli/index.ts'],
  format: ['esm', 'cjs'],
  target: 'node22',
  clean: true,
  shims: true,
  define: {
    __VERSION__: JSON.stringify(pkg.version),
  },
});
