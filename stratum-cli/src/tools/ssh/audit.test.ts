import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { StratumConfigSchema } from '../../config/schema.js';
import { createAuditLog, SSHAuditLog, type SSHAuditRecord } from './audit.js';
import { sshExecTool } from './exec.js';
import { getAuditLog, resetSshRuntime, closeSshPool } from './runtime.js';
import { startTestServer, type TestServer } from './test-server.js';
import { configWithHost, toolContext } from './ssh-test-utils.js';

function record(overrides: Partial<SSHAuditRecord> = {}): SSHAuditRecord {
  return {
    timestamp: new Date().toISOString(),
    host: 'dev',
    command: 'uptime',
    exitCode: 0,
    durationMs: 42,
    truncated: false,
    ...overrides,
  };
}

describe('SSHAuditLog', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'stratum-audit-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('escribe una línea JSON por comando y crea el directorio si falta', async () => {
    const path = join(dir, 'anidado', 'ssh-audit.jsonl');
    const log = new SSHAuditLog(path);

    log.write(record({ command: 'primero' }));
    log.write(record({ command: 'segundo', exitCode: 3 }));
    await log.flush();

    const lines = readFileSync(path, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).command).toBe('primero');
    expect(JSON.parse(lines[1]!).exitCode).toBe(3);
  });

  it('un fallo de escritura nunca propaga a la tool call', async () => {
    // Un directorio como destino: appendFile falla siempre.
    const log = new SSHAuditLog(dir);
    log.write(record());
    await expect(log.flush()).resolves.toBeUndefined();
  });
});

describe('createAuditLog', () => {
  it('devuelve un no-op cuando ssh.auditLog es false', async () => {
    const config = StratumConfigSchema.parse({
      ssh: { auditLog: false, hosts: { dev: { host: '1', user: 'u', useAgent: true } } },
    });
    const log = createAuditLog(config);
    expect(log).not.toBeInstanceOf(SSHAuditLog);
    log.write(record());
    await expect(log.flush()).resolves.toBeUndefined();
  });

  it('usa la ruta personalizada cuando ssh.auditLog es un string', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stratum-audit-'));
    const path = join(dir, 'propio.jsonl');
    const config = StratumConfigSchema.parse({
      ssh: { auditLog: path, hosts: { dev: { host: '1', user: 'u', useAgent: true } } },
    });

    const log = createAuditLog(config);
    log.write(record());
    await log.flush();

    expect(existsSync(path)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('ssh_exec escribe auditoría', () => {
  let server: TestServer;
  let dir: string;

  beforeAll(async () => {
    server = await startTestServer();
  });

  afterAll(async () => {
    await server.close();
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'stratum-audit-'));
  });

  afterEach(async () => {
    await closeSshPool();
    resetSshRuntime();
    rmSync(dir, { recursive: true, force: true });
  });

  it('registra el comando ejecutado con su exit code, duración y sessionId', async () => {
    const auditPath = join(dir, 'ssh-audit.jsonl');
    const config = configWithHost('dev', server.port);
    // configWithHost desactiva la auditoría por defecto; aquí sí la queremos.
    (config.ssh as { auditLog: string }).auditLog = auditPath;

    const result = await sshExecTool.execute(
      { host: 'dev', command: 'systemctl restart nginx' },
      toolContext(config, { sessionId: 'sess_test' }),
    );
    expect(result.ok).toBe(true);
    await getAuditLog(config).flush();

    const entry = JSON.parse(readFileSync(auditPath, 'utf-8').trim()) as SSHAuditRecord;
    expect(entry.host).toBe('dev');
    expect(entry.command).toBe('systemctl restart nginx');
    expect(entry.exitCode).toBe(0);
    expect(entry.sessionId).toBe('sess_test');
    expect(entry.truncated).toBe(false);
    expect(entry.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('registra también los comandos que fallan al conectar', async () => {
    const auditPath = join(dir, 'ssh-audit.jsonl');
    const config = configWithHost('dev', 1, { connectTimeout: 500 });
    (config.ssh as { auditLog: string }).auditLog = auditPath;

    const result = await sshExecTool.execute(
      { host: 'dev', command: 'uptime' },
      toolContext(config),
    );
    expect(result.ok).toBe(false);
    await getAuditLog(config).flush();

    const entry = JSON.parse(readFileSync(auditPath, 'utf-8').trim()) as SSHAuditRecord;
    expect(entry.exitCode).toBeNull();
    expect(entry.command).toBe('uptime');
  });

  it('omite sessionId cuando el contexto no lo trae', async () => {
    const auditPath = join(dir, 'ssh-audit.jsonl');
    const config = configWithHost('dev', server.port);
    (config.ssh as { auditLog: string }).auditLog = auditPath;

    await sshExecTool.execute({ host: 'dev', command: 'uptime' }, toolContext(config));
    await getAuditLog(config).flush();

    const entry = JSON.parse(readFileSync(auditPath, 'utf-8').trim()) as SSHAuditRecord;
    expect('sessionId' in entry).toBe(false);
  });
});
