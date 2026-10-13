import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { formatPendingTable } from '../cli/commands/approvals.js';
import { StratumClient } from '../client/client.js';
import { fileDiscovery } from '../client/discovery.js';
import { ProtocolError } from '../ipc/codec.js';
import {
  APPROVER_KEY_MIN_CHARS,
  approverKeyPath,
  loadApproverAuth,
  writeApproverKey,
} from './approver-key.js';
import { startTestDaemon, type TestDaemon } from './daemon.fixtures.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stratum-approver-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('clave de aprobador', () => {
  it('sin fichero no hay aprobadores', () => {
    expect(loadApproverAuth(dir)).toBeNull();
  });

  it('se guarda solo una derivación: quien lee el fichero no obtiene la clave', async () => {
    const key = 'una frase que solo sé yo';
    const path = await writeApproverKey(dir, key);
    expect(path).toBe(approverKeyPath(dir));
    const stored = readFileSync(path, 'utf-8');
    expect(stored).not.toContain(key);
    expect(JSON.parse(stored)).toMatchObject({ version: 1, algorithm: 'scrypt' });

    const auth = loadApproverAuth(dir)!;
    expect(await auth.verify(key)).toBe(true);
    expect(await auth.verify('otra frase distinta')).toBe(false);
    expect(await auth.verify('')).toBe(false);
    // La misma clave con otra sal no da el mismo fichero.
    await writeApproverKey(dir, key);
    expect(readFileSync(path, 'utf-8')).not.toBe(stored);
    expect(await loadApproverAuth(dir)!.verify(key)).toBe(true);
  });

  it('una clave trivial no se acepta', async () => {
    await expect(writeApproverKey(dir, 'x'.repeat(APPROVER_KEY_MIN_CHARS - 1))).rejects.toThrow(
      /at least/,
    );
    expect(loadApproverAuth(dir)).toBeNull();
  });

  it('un fichero que no valida falla cerrado: sin aprobadores, y se avisa', () => {
    let warned = 0;
    for (const content of [
      'no es json',
      '{}',
      JSON.stringify({ version: 2, algorithm: 'scrypt' }),
      // Parámetros rebajados para que cueste poco probar claves.
      JSON.stringify({
        version: 1,
        algorithm: 'scrypt',
        N: 2,
        r: 8,
        p: 1,
        salt: 'a'.repeat(32),
        hash: 'b'.repeat(64),
        createdAt: '',
      }),
    ]) {
      writeFileSync(approverKeyPath(dir), content);
      expect(
        loadApproverAuth(dir, () => warned++),
        content,
      ).toBeNull();
    }
    expect(warned).toBe(4);
  });
});

describe('handshake con clave de aprobador', () => {
  let t: TestDaemon | undefined;
  afterEach(async () => {
    await t?.stop();
    t = undefined;
  });

  const attempt = (approverKey?: string): Promise<string> =>
    t!.connect(['approver'], 'a', approverKey === undefined ? {} : { approverKey }).then(
      (client) => (client.capabilities.includes('approve') ? 'approve' : 'observe'),
      (err: unknown) => (err instanceof ProtocolError ? err.code : String(err)),
    );

  it('los fallos de otros no bloquean a un aprobador legítimo: no hay bloqueo global', async () => {
    t = await startTestDaemon();
    // Muchos más intentos fallidos de los que antes disparaban un bloqueo…
    for (let i = 0; i < 12; i++) expect(await attempt(`mala ${i}`)).toBe('UNAUTHORIZED');
    // …y la clave buena entra a la primera.
    expect(await attempt()).toBe('approve');

    // También con una ráfaga simultánea en curso: se atienden en orden y entra.
    const flood = Array.from({ length: 8 }, (_, i) => attempt(`ráfaga ${i}`));
    const good = attempt();
    expect(await good).toBe('approve');
    // Ninguna de la ráfaga entra (con la máquina cargada, alguna puede agotar su plazo).
    expect((await Promise.all(flood)).filter((r) => r === 'approve' || r === 'observe')).toEqual(
      [],
    );
    // El resto del daemon sigue atendiendo.
    expect((await t.connect(['observer'])).capabilities).toEqual(['observe']);
  }, 60_000);

  it('una clave errónea se contesta tarde, y solo a quien la presentó', async () => {
    t = await startTestDaemon({ approverFailureDelayMs: 600 });
    const started = Date.now();
    const bad = attempt('mala').then((code) => ({ code, ms: Date.now() - started }));
    // Mientras esa espera, otra conexión con la clave buena no espera con ella.
    await new Promise((r) => setTimeout(r, 50));
    const goodStarted = Date.now();
    expect(await attempt()).toBe('approve');
    expect(Date.now() - goodStarted).toBeLessThan(500);
    const failed = await bad;
    expect(failed.code).toBe('UNAUTHORIZED');
    expect(failed.ms).toBeGreaterThanOrEqual(550);
  }, 30_000);

  it('una conexión tiene un solo intento: tras fallar queda cerrada', async () => {
    t = await startTestDaemon();
    const client = new StratumClient({
      discovery: fileDiscovery({ dir: t.dir }),
      identity: {
        kind: 'cli',
        name: 'retry',
        version: '0',
        roles: ['approver'],
        approverKey: 'mala',
      },
      reconnect: false,
    });
    await expect(client.connect()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(client.status).toBe('closed');
    await expect(client.request('approvals.list', {})).rejects.toBeDefined();
  }, 30_000);
});

describe('stratum approvals — tabla', () => {
  it('lista los tres tipos con lo que hace falta para decidir', () => {
    const now = 1_000_000;
    const table = formatPendingTable(
      {
        approvals: [
          {
            id: 'apr_1',
            kind: 'tool',
            sessionId: 'sess_a',
            runId: 'run_1',
            tool: 'exec',
            description: 'exec [ssh:prod-db]: systemctl restart postgresql',
            target: 'ssh:prod-db',
            environment: { name: 'prod', tier: 'production' },
            forced: true,
            confirmPhrase: 'prod-db',
            resolvable: 'origin',
            requestedAt: now - 65_000,
            expiresAt: null,
            status: 'pending',
          },
        ],
        questions: [
          {
            id: 'qst_1',
            sessionId: 'sess_b',
            runId: 'run_2',
            questions: [{ question: '¿Entorno?' }],
            requestedAt: now - 5_000,
            expiresAt: now + 595_000,
          },
        ],
        plans: [
          {
            id: 'pln_1',
            sessionId: 'sess_c',
            runId: 'run_3',
            plan: { summary: 'Limpieza', steps: [{ id: '1', title: 'a', status: 'pending' }] },
            requestedAt: now,
            expiresAt: null,
          },
        ],
      },
      now,
    );
    const lines = table.trimEnd().split('\n');
    expect(lines[0]).toMatch(/^ID\s+KIND\s+SESSION\s+AGE\s+EXPIRES\s+WHAT$/);
    expect(lines[1]).toMatch(/^apr_1\s+approval\s+sess_a\s+1m05s\s+-\s+exec @ssh:prod-db/);
    expect(lines[1]).toContain('[prod/production, forced, phrase, origin-only]');
    expect(lines[2]).toMatch(/^qst_1\s+question\s+sess_b\s+5s\s+9m55s\s+¿Entorno\?$/);
    expect(lines[3]).toMatch(/^pln_1\s+plan\s+sess_c\s+0s\s+-\s+1 steps: Limpieza$/);
    expect(formatPendingTable({ approvals: [], questions: [], plans: [] })).toBe(
      'Nothing pending.\n',
    );
  });
});
