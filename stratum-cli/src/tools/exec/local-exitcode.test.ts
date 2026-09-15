import { describe, it, expect } from 'vitest';
import { localBackend } from './backends/local.js';
import { StratumConfigSchema } from '../../config/schema.js';
import type { ToolContext } from '../../agent/types.js';
import type { ExecRequest } from './backend.js';

const config = StratumConfigSchema.parse({ tools: { auditLog: false } });

function ctx(): ToolContext {
  return { signal: new AbortController().signal, cwd: process.cwd(), config };
}

function req(command: string, overrides: Partial<ExecRequest> = {}): ExecRequest {
  return {
    command,
    timeoutMs: 20000,
    maxBytes: 1024 * 1024,
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe('backend local — la decisión del exit code no toca la salida (Hito 16)', () => {
  it('un stderr legítimo con la frase NativeCommandExitException se conserva', async () => {
    const out = await localBackend.run(
      { kind: 'local' },
      req(`node -e "process.stderr.write('NativeCommandExitException: keep me'); process.exit(2)"`),
      ctx(),
    );
    expect(out.stderr).toContain('NativeCommandExitException: keep me');
    expect(out.exitCode).toBe(2);
  });

  it('un maxBytes pequeño con un nativo que sale ≠ 0 no se trunca por ruido del envoltorio', async () => {
    const out = await localBackend.run(
      { kind: 'local' },
      req(`node -e "process.stderr.write('ab'); process.exit(3)"`, { maxBytes: 10 }),
      ctx(),
    );
    expect(out.status).toBe('exited');
    expect(out.exitCode).toBe(3);
    expect(out.stderr).toBe('ab');
    expect(out.bytesDiscarded).toBeUndefined();
  });
});

describe.skipIf(process.platform !== 'win32')(
  'backend local en Windows — exit code del último fallo realmente ejecutado',
  () => {
    const cases: Array<[string, number]> = [
      // Entre sentencias, en líneas distintas.
      ['cmd /c exit 7\nGet-Item no-existe-stratum-xyz', 1],
      ['Get-Item no-existe-stratum-xyz\ncmd /c exit 7', 7],
      // Dentro de una misma sentencia compuesta, en los dos órdenes.
      ['if ($true) { Get-Item no-existe-stratum-xyz; cmd /c exit 7 }', 7],
      ['if ($true) { cmd /c exit 7; Get-Item no-existe-stratum-xyz }', 1],
      ['if ($true) {\n  cmd /c exit 9\n}', 9],
      [
        'foreach ($i in 1..2) { if ($i -eq 2) { Get-Item no-existe-stratum-xyz; cmd /c exit 3 } }',
        3,
      ],
      // Un nativo que termina bien no hace «último fallo» a un cmdlet anterior.
      ['node -e "process.exit(0)"; Get-Item no-existe-stratum-xyz', 1],
      // Semántica de `$?` de PowerShell: tras una función, `$?` es true.
      ['function f { cmd /c exit 8 }; Get-Item no-existe-stratum-xyz; f', 0],
    ];
    for (const [command, expected] of cases) {
      it(`${JSON.stringify(command)} → ${expected}`, async () => {
        const out = await localBackend.run({ kind: 'local' }, req(command), ctx());
        expect(out.exitCode).toBe(expected);
        expect(out.stderr).not.toMatch(
          /PostCommandLookupAction|InvalidOperation|NativeCommandExitException/,
        );
      });
    }
  },
);
