import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createExecTool } from './exec.js';
import { createExecAuditLog, ExecAuditLog } from './audit.js';
import { getExecAuditLog, resetExecRuntime } from './runtime.js';
import { ToolRegistry, ToolDispatcher } from '../registry.js';
import { StratumConfigSchema, type StratumConfig } from '../../config/schema.js';
import type { ToolContext } from '../../agent/types.js';

const dirs: string[] = [];

async function tempLog(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'stratum-exec-audit-'));
  dirs.push(dir);
  return join(dir, 'exec-audit.jsonl');
}

async function records(config: StratumConfig, path: string): Promise<Record<string, unknown>[]> {
  await getExecAuditLog(config).flush();
  if (!existsSync(path)) return [];
  return (await readFile(path, 'utf8'))
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function ctx(config: StratumConfig, overrides: Partial<ToolContext> = {}): ToolContext {
  return { signal: new AbortController().signal, cwd: process.cwd(), config, ...overrides };
}

afterEach(async () => {
  resetExecRuntime();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe('auditoría universal de exec (Hito 16)', () => {
  it('registra un comando local con target, status, cwd efectivo y sessionId', async () => {
    const path = await tempLog();
    const config = StratumConfigSchema.parse({ tools: { auditLog: path } });
    await createExecTool(config).execute(
      { command: 'node -e "process.exit(4)"' },
      ctx(config, { sessionId: 'sess_test' }),
    );
    const [rec] = await records(config, path);
    expect(rec).toMatchObject({
      sessionId: 'sess_test',
      target: 'local',
      status: 'exited',
      exitCode: 4,
      truncated: false,
      cwd: process.cwd(),
    });
    expect(rec).not.toHaveProperty('host');
  });

  it('el comando se guarda redactado con el núcleo y los extras; stdin nunca', async () => {
    const path = await tempLog();
    const config = StratumConfigSchema.parse({
      tools: {
        auditLog: path,
        redaction: { extraPatterns: [{ value: 'hunter2hunter2', reason: 'db password' }] },
      },
    });
    await createExecTool(config).execute(
      {
        command: 'node -e "0" --token sk-proj-AbCdEf0123456789XyZ_abc --pw hunter2hunter2',
        stdin: 'stdin-secreto',
      },
      ctx(config),
    );
    const [rec] = await records(config, path);
    const line = JSON.stringify(rec);
    expect(line).not.toContain('sk-proj-AbCd');
    expect(line).not.toContain('hunter2hunter2');
    expect(line).not.toContain('stdin-secreto');
    expect(line).toContain('[redacted: db password]');
  });

  it('un comando vetado no llega a ejecutarse y no se audita', async () => {
    const path = await tempLog();
    const config = StratumConfigSchema.parse({ tools: { auditLog: path } });
    const registry = new ToolRegistry();
    registry.register(createExecTool(config));
    const results = await new ToolDispatcher(registry).dispatch(
      [{ id: 'c1', name: 'exec', input: { command: 'rm -rf /' } }],
      ctx(config, { destructivePolicy: 'allow' }),
    );
    expect(results[0]!.result.ok).toBe(false);
    expect(await records(config, path)).toEqual([]);
  });
});

describe('createExecAuditLog — destino', () => {
  it('tools.auditLog false desactiva; string es la ruta; el alias ssh.auditLog se respeta sin tools', () => {
    const off = StratumConfigSchema.parse({ tools: { auditLog: false } });
    expect(createExecAuditLog(off)).not.toBeInstanceOf(ExecAuditLog);

    const custom = StratumConfigSchema.parse({ tools: { auditLog: '/tmp/a.jsonl' } });
    expect((createExecAuditLog(custom) as ExecAuditLog).path).toContain('a.jsonl');

    const def = StratumConfigSchema.parse({});
    expect((createExecAuditLog(def) as ExecAuditLog).path).toContain('exec-audit.jsonl');
  });
});
