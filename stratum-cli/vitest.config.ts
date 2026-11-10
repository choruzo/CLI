import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Un test que monta `run` o `chat` en proceso no se publica en el `stratumd`
    // que el desarrollador tenga en marcha. Los tests del anfitrión par lo
    // reactivan a propósito, contra un daemon de pruebas.
    // Tampoco carga los plugins del desarrollador (`~/.stratum/plugins/`, config
    // global): solo los que el test pida con `paths` o con un directorio propio.
    // Ni el navegador instalado en la máquina (`tools.browser`): el toolset de
    // un test no depende de si hay un Edge o un Chrome. Los del navegador usan
    // uno falso, o `locateBrowser` directo (el de integración).
    env: { STRATUM_NO_DAEMON: '1', STRATUM_NO_PLUGINS: '1', STRATUM_NO_BROWSER: '1' },
  },
});
