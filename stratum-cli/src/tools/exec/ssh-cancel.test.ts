import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createExecTool } from './exec.js';
import { resetExecRuntime } from './runtime.js';
import { resetSshRuntime, closeSshPool, getSshPool } from '../ssh/runtime.js';
import { startTestServer, type TestServer } from '../ssh/test-server.js';
import { configWithHost, toolContext } from '../ssh/ssh-test-utils.js';

/**
 * Hito 16 — cancelación estructurada mientras el servidor aún no ha aceptado
 * el canal de `exec`. La petición ya salió y SSH no permite retirarla: lo
 * exigible es resolver `cancelled` en un tiempo acotado y matar el canal en
 * cuanto llegue.
 */
describe('exec sobre ssh — cancelación durante la apertura del canal', () => {
  let server: TestServer;
  const signals: string[] = [];

  beforeAll(async () => {
    server = await startTestServer({
      execAcceptDelayMs: 1500,
      onExec: (req) => {
        req.onSignal((name) => {
          signals.push(name);
          req.stream.exit(137);
          req.stream.end();
        });
      },
    });
  });

  afterAll(async () => {
    await server.close();
  });

  afterEach(async () => {
    await closeSshPool();
    resetSshRuntime();
    resetExecRuntime();
  });

  it('resuelve cancelled sin esperar al canal y lo mata cuando llega', async () => {
    const config = configWithHost('dev', server.port);
    const ctx = toolContext(config);
    // Conexión ya establecida: lo que se mide es solo la apertura del canal.
    await getSshPool(config).getConnection('dev');

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 150);
    const started = Date.now();
    const result = await createExecTool(config).execute(
      { target: 'ssh:dev', command: 'hang', timeout: 20000 },
      { ...ctx, signal: controller.signal },
    );
    const elapsed = Date.now() - started;

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain('status="cancelled"');
    expect(elapsed).toBeLessThan(1200);

    // El canal llega después (1,5 s) y se mata en el acto.
    await new Promise((r) => setTimeout(r, 2000));
    expect(signals).toContain('KILL');
  });

  it('el timeout también cuenta mientras el canal no se abre', async () => {
    const config = configWithHost('dev', server.port);
    const started = Date.now();
    const result = await createExecTool(config).execute(
      { target: 'ssh:dev', command: 'hang', timeout: 300 },
      toolContext(config),
    );
    expect(!result.ok && result.error).toContain('status="timeout"');
    expect(Date.now() - started).toBeLessThan(1200);
  });
});
