import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { sshExecTool } from './exec.js';
import { resetSshRuntime, closeSshPool } from './runtime.js';
import { startTestServer, type TestServer } from './test-server.js';
import { configWithHost, toolContext } from './ssh-test-utils.js';

describe('ssh_exec', () => {
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
  });

  async function run(params: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
    const config = configWithHost('dev', server.port, overrides);
    return sshExecTool.execute({ host: 'dev', ...params }, toolContext(config));
  }

  it('ejecuta un comando y devuelve stdout en el resultado XML', async () => {
    const result = await run({ command: 'uptime' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.output).toContain('<ssh_result host="dev"');
    expect(result.output).toContain('exitCode="0"');
    expect(result.output).toContain('uptime');
  });

  it('propaga el exit code y captura stderr', async () => {
    const result = await run({ command: 'fail 3' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.output).toContain('exitCode="3"');
    expect(result.output).toContain('<stderr>');
    expect(result.output).toContain('código 3');
  });

  it('envía el parámetro stdin al comando remoto', async () => {
    const result = await run({ command: 'cat', stdin: 'hola desde stdin' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.output).toContain('hola desde stdin');
  });

  it('prefija cwd al comando', async () => {
    const result = await run({ command: 'pwd-echo', cwd: '/var/log' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // El `&&` sale escapado: el resultado se inyecta al modelo como XML.
    expect(result.output).toContain("cd '/var/log' &amp;&amp; pwd-echo");
  });

  it('trunca la salida al superar maxBytes y mata el proceso remoto', async () => {
    const result = await run({ command: 'flood', maxBytes: 8192 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.output).toContain('truncated="true"');
    expect(result.output).toContain('OUTPUT TRUNCATED at 8192 bytes');
    expect(result.output).toContain('exitCode="truncated"');
  });

  it('mata un comando que no termina al expirar el timeout', async () => {
    const result = await run({ command: 'hang', timeout: 300 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.output).toContain('COMMAND KILLED after 300ms timeout');
  });

  it('devuelve un error recuperable con los alias disponibles si el host no existe', async () => {
    const config = configWithHost('dev', server.port);
    const result = await sshExecTool.execute(
      { host: 'inexistente', command: 'ls' },
      toolContext(config),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.recoverable).toBe(true);
    expect(result.error).toContain('Hosts disponibles: dev');
  });

  describe('confirmación destructiva', () => {
    it('pide confirmación en TODO comando cuando el host lleva confirmAll', () => {
      const config = configWithHost('prod', 22, { confirmAll: true });
      const destructive = sshExecTool.isDestructive?.(
        { host: 'prod', command: 'ls -la' },
        toolContext(config),
      );
      expect(destructive).toBe(true);
    });

    it('no pide confirmación para un comando inocuo sin confirmAll', () => {
      const config = configWithHost('dev', 22);
      const destructive = sshExecTool.isDestructive?.(
        { host: 'dev', command: 'ls -la' },
        toolContext(config),
      );
      expect(destructive).toBe(false);
    });

    it('detecta patrones destructivos con la misma lógica que bash', () => {
      const config = configWithHost('dev', 22);
      const destructive = sshExecTool.isDestructive?.(
        { host: 'dev', command: 'rm -rf /var/cache' },
        toolContext(config),
      );
      expect(destructive).toBe(true);
    });
  });
});
