/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'url';

const cliRoot = fileURLToPath(new URL('../stratum-cli', import.meta.url));

// Configuración recomendada por Tauri v2: puerto fijo (tauri.conf.json →
// build.devUrl), sin limpiar la pantalla (se pierden los errores de Rust) y sin
// vigilar src-tauri (lo recompila cargo).
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: '127.0.0.1',
    // `src/theme.ts` reexporta la paleta de stratum-cli, fuera de este workspace.
    fs: { allow: ['.', cliRoot] },
    watch: { ignored: ['**/src-tauri/**'] },
  },
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  build: {
    // WebView2 (Windows) y WebKitGTK (Linux) de las plataformas soportadas.
    target: process.env.TAURI_ENV_PLATFORM === 'windows' ? 'chrome105' : 'safari15',
    minify: !process.env.TAURI_ENV_DEBUG,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}', 'scripts/**/*.test.mjs'],
  },
});
