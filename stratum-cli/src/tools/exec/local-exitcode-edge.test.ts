import { describe, it, expect } from 'vitest';
import { localBackend } from './backends/local.js';
import { StratumConfigSchema } from '../../config/schema.js';
import type { ToolContext } from '../../agent/types.js';

/**
 * Hito 16 — contrato best-effort del exit code en Windows (§12.17), fijado con
 * los resultados medidos. Una sesión que ya arranca en `ConstrainedLanguage` no
 * se puede forzar desde un test (`__PSLockdownPolicy` no la activa sin política
 * del sistema): su rama de respaldo es la misma que la de «gancho reemplazado»,
 * que sí se prueba aquí.
 */
const config = StratumConfigSchema.parse({ tools: { auditLog: false } });

function ctx(): ToolContext {
  return { signal: new AbortController().signal, cwd: process.cwd(), config };
}

async function exitCodeOf(command: string): Promise<number | null> {
  const out = await localBackend.run(
    { kind: 'local' },
    { command, timeoutMs: 20000, maxBytes: 1024 * 1024, signal: new AbortController().signal },
    ctx(),
  );
  expect(out.stderr).not.toMatch(/__stratum|InvalidOperation/);
  return out.exitCode;
}

const RESET_HOOK = '$ExecutionContext.InvokeCommand.PostCommandLookupAction = $null';

describe.skipIf(process.platform !== 'win32')(
  'backend local en Windows — casos límite (Hito 16)',
  () => {
    it('tuberías: el exit code del nativo final cuenta; un cmdlet antes del nativo gana', async () => {
      expect(await exitCodeOf('cmd /c exit 7 | Out-String')).toBe(7);
      expect(await exitCodeOf('Get-Item no-existe-stratum-xyz | cmd /c exit 7')).toBe(1);
      expect(await exitCodeOf('cmd /c "echo hi" | Select-String nomatch')).toBe(0);
    });

    it('un comando que reemplaza el gancho cae al respaldo sin orden, sin datos obsoletos', async () => {
      expect(await exitCodeOf(`${RESET_HOOK}; cmd /c exit 6`)).toBe(6);
      // Sin orden fiable: hubo un error de PowerShell → 1 (documentado).
      expect(await exitCodeOf(`${RESET_HOOK}; Get-Item no-existe-stratum-xyz; cmd /c exit 7`)).toBe(
        1,
      );
    });

    it('si el último comando termina bien, 0 en todos los modos (como POSIX: `false; x=1` → 0)', async () => {
      // Con el gancho.
      expect(await exitCodeOf('cmd /c exit 6; $x = 1')).toBe(0);
      // Con el gancho reemplazado antes (respaldo).
      expect(await exitCodeOf(`${RESET_HOOK}; cmd /c exit 6; $x = 1`)).toBe(0);
      // Con el reemplazo del gancho como última operación, tras un fallo.
      expect(await exitCodeOf(`cmd /c exit 7; ${RESET_HOOK}`)).toBe(0);
    });
  },
);
