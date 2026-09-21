/**
 * Entry alternativo del core para Stratum Desktop: el sidecar `stratum-core`.
 * Lo compila `tsup.desktop.config.ts` a un único CommonJS que `build-sea.mjs`
 * (en `stratum-desktop/scripts/`) convierte en binario Node SEA. Ver
 * `src/desktop/main.ts` para el contrato con el proceso Tauri.
 */
import { runSidecar } from './desktop/main.js';

process.env.STRATUM_DESKTOP = '1';

runSidecar(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(
      `stratum-core: error fatal: ${err instanceof Error ? err.stack : String(err)}\n`,
    );
    process.exit(1);
  },
);
