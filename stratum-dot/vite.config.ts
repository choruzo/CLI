/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'url';

const cliRoot = fileURLToPath(new URL('../stratum-cli', import.meta.url));

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  resolve: {
    // `src/protocol/` reexporta el contrato de stratum-cli (`src/protocol/`), que
    // está fuera de este paquete: su `zod` tiene que ser el de aquí.
    alias: { zod: fileURLToPath(new URL('./node_modules/zod', import.meta.url)) },
  },
  server: {
    // 1420 es de Stratum Desktop: las dos apps conviven.
    port: 1421,
    strictPort: true,
    host: '127.0.0.1',
    fs: { allow: ['.', cliRoot] },
    watch: { ignored: ['**/src-tauri/**', '**/target/**', '**/crates/**'] },
  },
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  build: {
    target: process.env.TAURI_ENV_PLATFORM === 'windows' ? 'chrome105' : 'safari15',
    minify: !process.env.TAURI_ENV_DEBUG,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}', 'tests/**/*.test.ts'],
  },
});
