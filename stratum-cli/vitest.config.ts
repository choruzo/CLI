import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Un test que monta `run` o `chat` en proceso no se publica en el `stratumd`
    // que el desarrollador tenga en marcha. Los tests del anfitrión par lo
    // reactivan a propósito, contra un daemon de pruebas.
    env: { STRATUM_NO_DAEMON: '1' },
  },
});
