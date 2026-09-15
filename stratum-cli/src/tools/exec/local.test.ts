import { describe, it, expect, vi, afterEach } from 'vitest';
import { execa } from 'execa';
import { localBackend, ByteBudget } from './backends/local.js';
import { createExecTool } from './exec.js';
import { resetExecRuntime } from './runtime.js';
import { StratumConfigSchema } from '../../config/schema.js';
import type { ToolContext } from '../../agent/types.js';
import type { ExecRequest } from './backend.js';

vi.mock('execa', async (importOriginal) => {
  const mod = await importOriginal<typeof import('execa')>();
  return { ...mod, execa: vi.fn((...args: Parameters<typeof mod.execa>) => mod.execa(...args)) };
});

const config = StratumConfigSchema.parse({ tools: { auditLog: false } });

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return { signal: new AbortController().signal, cwd: process.cwd(), config, ...overrides };
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

/** `node -e` es portable entre pwsh (Windows) y /bin/sh. */
const node = (script: string): string => `node -e "${script}"`;

afterEach(() => {
  resetExecRuntime();
});

describe('ByteBudget', () => {
  it('conserva hasta el byte límite aunque un chunk lo atraviese y cuenta el resto', () => {
    const budget = new ByteBudget(1000);
    budget.push(Buffer.alloc(600, 'a'), 'stdout');
    budget.push(Buffer.alloc(600, 'b'), 'stderr');
    budget.push(Buffer.alloc(50, 'c'), 'stdout');
    expect(budget.text('stdout')).toBe('a'.repeat(600));
    expect(budget.text('stderr')).toBe('b'.repeat(400));
    expect(budget.discarded).toBe(250);
    expect(budget.truncated).toBe(true);
  });
});

describe('backend local (Hito 16)', () => {
  it('ejecuta, captura stdout/stderr y el exit code real', async () => {
    const out = await localBackend.run(
      { kind: 'local' },
      req(node("process.stdout.write('hola'); process.stderr.write('mal'); process.exit(3)")),
      ctx(),
    );
    expect(out.status).toBe('exited');
    expect(out.exitCode).toBe(3);
    expect(out.stdout).toBe('hola');
    expect(out.stderr).toBe('mal');
  });

  it('pasa buffer:false a execa (su buffer interno falla a partir de 100 MB)', async () => {
    vi.mocked(execa).mockClear();
    await localBackend.run({ kind: 'local' }, req(node('0')), ctx());
    // En Windows se invoca `pwsh.exe <args> <options>`; en POSIX `<command> <options>`.
    const call = vi.mocked(execa).mock.calls[0] as unknown[];
    const options = call[call.length - 1] as Record<string, unknown>;
    expect(options.buffer).toBe(false);
    expect(options.extendEnv).toBe(false);
  });

  it('envía stdin y cierra la entrada; sin stdin, EOF inmediato', async () => {
    const withInput = await localBackend.run(
      { kind: 'local' },
      req(node('process.stdin.pipe(process.stdout)'), { stdin: 'desde stdin' }),
      ctx(),
    );
    expect(withInput.stdout).toBe('desde stdin');

    const withoutInput = await localBackend.run(
      { kind: 'local' },
      req(node('process.stdin.pipe(process.stdout)'), { timeoutMs: 8000 }),
      ctx(),
    );
    expect(withoutInput.status).toBe('exited');
    expect(withoutInput.exitCode).toBe(0);
  });

  it('resuelve un cwd relativo contra el directorio del proyecto', async () => {
    const out = await localBackend.run(
      { kind: 'local' },
      req(node('process.stdout.write(process.cwd())'), { cwd: 'src' }),
      ctx(),
    );
    expect(out.stdout.replace(/\\/g, '/').endsWith('/src')).toBe(true);
    expect(out.cwd).toBe(out.stdout);
  });

  it('pasado maxBytes descarta el resto pero deja terminar el proceso', async () => {
    const out = await localBackend.run(
      { kind: 'local' },
      req(node("process.stdout.write('x'.repeat(3000000)); process.exitCode = 0"), {
        maxBytes: 1000,
      }),
      ctx(),
    );
    expect(out.status).toBe('truncated');
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toHaveLength(1000);
    expect(out.bytesDiscarded).toBe(3000000 - 1000);
  });

  it('mata el proceso al vencer el timeout', async () => {
    const started = Date.now();
    const out = await localBackend.run(
      { kind: 'local' },
      req(node('setTimeout(() => {}, 60000)'), { timeoutMs: 700 }),
      ctx(),
    );
    expect(out.status).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(6000);
  });

  it('truncado seguido de timeout termina como timeout, con los bytes descartados', async () => {
    const out = await localBackend.run(
      { kind: 'local' },
      req(node("process.stdout.write('y'.repeat(5000)); setTimeout(() => {}, 60000)"), {
        maxBytes: 100,
        timeoutMs: 1500,
      }),
      ctx(),
    );
    expect(out.status).toBe('timeout');
    expect(out.bytesDiscarded).toBeGreaterThan(0);
  });

  it('una cancelación resuelve con cancelled, no rechaza', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 500);
    const out = await localBackend.run(
      { kind: 'local' },
      req(node('setTimeout(() => {}, 60000)'), { signal: controller.signal }),
      ctx(),
    );
    expect(out.status).toBe('cancelled');
  });

  it('no hereda las variables de enrutado de git', async () => {
    const previous = process.env.GIT_DIR;
    process.env.GIT_DIR = '/otro/repo/.git';
    try {
      const out = await localBackend.run(
        { kind: 'local' },
        req(node('process.stdout.write(String(process.env.GIT_DIR))')),
        ctx(),
      );
      expect(out.stdout).toBe('undefined');
    } finally {
      if (previous === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = previous;
    }
  });
});

describe.skipIf(process.platform !== 'win32')(
  'backend local en Windows — exit code del último fallo',
  () => {
    const cases: Array<[string, number]> = [
      ['cmd /c exit 5', 5],
      ['Get-Item no-existe-stratum-xyz', 1],
      // Un nativo falló antes, pero el último fallo es un cmdlet: 1, no el 7 obsoleto.
      ['cmd /c exit 7; Get-Item no-existe-stratum-xyz', 1],
      // Y al revés: el cmdlet falló antes, el último fallo es el nativo.
      ['Get-Item no-existe-stratum-xyz; cmd /c exit 7', 7],
      // Un fallo intermedio seguido de éxito no contamina el resultado.
      ['cmd /c exit 4; echo ok', 0],
      ['node -e "process.exit(0)"; cmd /c exit 3', 3],
    ];
    for (const [command, expected] of cases) {
      it(`${command} → ${expected}`, async () => {
        const out = await localBackend.run({ kind: 'local' }, req(command), ctx());
        expect(out.exitCode).toBe(expected);
      });
    }
  },
);

describe('exec sobre target local', () => {
  const tool = createExecTool(config);

  it('exit 0 → ok con <exec_result>', async () => {
    const result = await tool.execute({ command: node("process.stdout.write('ok')") }, ctx());
    expect(result.ok).toBe(true);
    expect(result.ok && result.output).toContain(
      '<exec_result target="local" status="exited" exitCode="0"',
    );
  });

  it('exit ≠ 0 → tool_error recuperable que no consume reintento y marca executed', async () => {
    const result = await tool.execute({ command: node('process.exit(2)') }, ctx());
    expect(result).toMatchObject({
      ok: false,
      recoverable: true,
      countsAsFailure: false,
      executed: true,
    });
    expect(!result.ok && result.error).toContain('exitCode="2"');
  });

  it('pty en local se rechaza en preflight nombrando los targets que lo soportan', () => {
    const veto = tool.preflight!({ command: 'sudo visudo', pty: true }, ctx());
    expect(veto).toMatchObject({ ok: false, recoverable: true });
    expect(veto && !veto.ok && veto.error).toContain('ssh:<alias>');
  });
});
