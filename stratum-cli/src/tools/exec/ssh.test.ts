import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createExecTool } from './exec.js';
import { resetExecRuntime } from './runtime.js';
import { resetSshRuntime, closeSshPool } from '../ssh/runtime.js';
import { startTestServer, type TestServer } from '../ssh/test-server.js';
import { configWithHost, toolContext } from '../ssh/ssh-test-utils.js';
import type { ToolResult } from '../../agent/types.js';

/** Texto del resultado, sea ok o tool_error: los dos llevan el <exec_result>. */
function textOf(result: ToolResult): string {
  return result.ok ? result.output : result.error;
}

describe('exec sobre target ssh (Hito 16)', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startTestServer();
  });

  afterAll(async () => {
    await server.close();
  });

  afterEach(async () => {
    await closeSshPool();
    resetSshRuntime();
    resetExecRuntime();
  });

  async function run(
    params: Record<string, unknown>,
    overrides: Record<string, unknown> = {},
    alias = 'dev',
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    const config = configWithHost(alias, server.port, overrides);
    const tool = createExecTool(config);
    return tool.execute(
      { target: `ssh:${alias}`, ...params },
      toolContext(config, signal ? { signal } : {}),
    );
  }

  it('ejecuta un comando y devuelve el <exec_result> del target', async () => {
    const result = await run({ command: 'uptime' });
    expect(result.ok).toBe(true);
    expect(textOf(result)).toContain('<exec_result target="ssh:dev" status="exited" exitCode="0"');
    expect(textOf(result)).toContain('uptime');
  });

  it('un exit ≠ 0 es tool_error recuperable, no contable y executed, con stderr', async () => {
    const result = await run({ command: 'fail 3' });
    expect(result).toMatchObject({
      ok: false,
      recoverable: true,
      countsAsFailure: false,
      executed: true,
    });
    expect(textOf(result)).toContain('exitCode="3"');
    expect(textOf(result)).toContain('<stderr>');
  });

  it('envía stdin al comando remoto', async () => {
    const result = await run({ command: 'cat', stdin: 'hola desde stdin' });
    expect(textOf(result)).toContain('hola desde stdin');
  });

  it('sin stdin, cat recibe EOF inmediato con y sin PTY', async () => {
    for (const pty of [false, true]) {
      const started = Date.now();
      const result = await run({ command: 'cat', pty, timeout: 5000 });
      expect(textOf(result)).toContain('status="exited"');
      expect(Date.now() - started).toBeLessThan(4000);
    }
  });

  it('prefija cwd y lo reporta como requestedCwd', async () => {
    const result = await run({ command: 'pwd-echo', cwd: '/var/log' });
    expect(textOf(result)).toContain('requestedCwd="/var/log"');
    expect(textOf(result)).toContain("cd '/var/log' &amp;&amp; pwd-echo");
  });

  it('pasado maxBytes mata el proceso remoto y conserva hasta el límite', async () => {
    const result = await run({ command: 'flood', maxBytes: 10000 });
    expect(textOf(result)).toContain('status="truncated"');
    expect(textOf(result)).toContain(
      'OUTPUT TRUNCATED at 10000 bytes; the remote process was killed',
    );
  });

  it('mata un comando que no termina al vencer el timeout', async () => {
    const result = await run({ command: 'hang', timeout: 300 });
    expect(textOf(result)).toContain('status="timeout"');
    expect(textOf(result)).toContain('COMMAND KILLED after 300ms');
  });

  it('una cancelación resuelve con cancelled', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);
    const result = await run({ command: 'hang', timeout: 20000 }, {}, 'dev', controller.signal);
    expect(textOf(result)).toContain('status="cancelled"');
  });

  it('una señal ya abortada devuelve cancelled sin abrir conexión', async () => {
    const before = server.connectionCount();
    const controller = new AbortController();
    controller.abort();
    const result = await run({ command: 'uptime' }, {}, 'dev', controller.signal);
    expect(textOf(result)).toContain('status="cancelled"');
    expect(server.connectionCount()).toBe(before);
  });

  it('un alias desconocido es un error recuperable', async () => {
    const config = configWithHost('dev', server.port);
    const result = await createExecTool(config).execute(
      { target: 'ssh:nope', command: 'uptime' },
      toolContext(config),
    );
    expect(result).toMatchObject({ ok: false, recoverable: true });
  });

  it('un mismatch de host key no es recuperable', async () => {
    const result = await run(
      { command: 'uptime' },
      { hostKeyPolicy: 'strict', hostKeyHash: 'SHA256:no-es-esta-clave' },
    );
    expect(result).toMatchObject({ ok: false, recoverable: false });
  });

  it('escapa el alias en el atributo XML', async () => {
    const result = await run({ command: 'uptime' }, {}, 'we"ird');
    expect(textOf(result)).toContain('target="ssh:we&quot;ird"');
  });
});
