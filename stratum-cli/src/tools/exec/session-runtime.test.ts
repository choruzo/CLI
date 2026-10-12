import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StratumConfigSchema, type StratumConfig } from '../../config/schema.js';
import { JobManager } from '../../jobs/manager.js';
import { MAIN_JOB_SCOPE } from '../../jobs/types.js';
import { getSshPool, resetSshRuntime } from '../ssh/runtime.js';
import {
  closeExecRuntime,
  closeSessionExecRuntime,
  getExecAuditLog,
  resetExecRuntime,
} from './runtime.js';

// Estos tests lanzan y matan árboles de procesos reales: en Windows cada
// cancelación barre los descendientes (~1 s) y, con la suite completa en
// paralelo, el límite por defecto de 5 s no da margen.
vi.setConfig({ testTimeout: 30_000 });

/**
 * Aislamiento del estado de ejecución entre sesiones de un mismo proceso (M0
 * del PRD de Stratum Dot): cada sesión tiene su config y, con ella, sus jobs,
 * sus conexiones SSH y su auditoría. Cerrar una no toca nada de la otra.
 */

const node = (script: string): string => `node -e "${script}"`;
const main = { scope: MAIN_JOB_SCOPE };

let dir: string;
let managers: JobManager[];

function sessionConfig(name: string): StratumConfig {
  return StratumConfigSchema.parse({ tools: { auditLog: join(dir, `${name}-audit.jsonl`) } });
}

function jobs(config: StratumConfig): JobManager {
  const m = new JobManager(config, { killGraceMs: 300 });
  managers.push(m);
  return m;
}

function auditLines(name: string): string[] {
  return readFileSync(join(dir, `${name}-audit.jsonl`), 'utf-8')
    .trim()
    .split('\n');
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stratum-session-runtime-'));
  managers = [];
  resetExecRuntime();
  resetSshRuntime();
});

afterEach(async () => {
  await Promise.allSettled(managers.map((m) => m.shutdown()));
  await closeExecRuntime();
  rmSync(dir, { recursive: true, force: true });
});

describe('estado de ejecución por sesión', () => {
  it('cada config tiene su pool SSH y su log de auditoría, estables entre llamadas', () => {
    const a = sessionConfig('a');
    const b = sessionConfig('b');

    expect(getSshPool(a)).toBe(getSshPool(a));
    expect(getSshPool(a)).not.toBe(getSshPool(b));
    expect(getExecAuditLog(a)).toBe(getExecAuditLog(a));
    expect(getExecAuditLog(a)).not.toBe(getExecAuditLog(b));
  });

  it('pedir el estado de otra sesión no cierra ni sustituye el de la primera', () => {
    const a = sessionConfig('a');
    const poolA = getSshPool(a);
    const auditA = getExecAuditLog(a);
    let closed = 0;
    poolA.closeAll = async () => void closed++;

    getSshPool(sessionConfig('b'));
    getExecAuditLog(sessionConfig('b'));

    expect(closed).toBe(0);
    expect(getSshPool(a)).toBe(poolA);
    expect(getExecAuditLog(a)).toBe(auditA);
  });

  it('cerrar una sesión cancela sus jobs y deja vivos los de la otra', async () => {
    const a = sessionConfig('a');
    const b = sessionConfig('b');
    const jobsA = jobs(a);
    const jobsB = jobs(b);
    const jobA = await jobsA.start({
      command: node('setInterval(() => {}, 1000)'),
      cwd: dir,
      owner: main,
    });
    const jobB = await jobsB.start({
      command: node('setInterval(() => {}, 1000)'),
      cwd: dir,
      owner: main,
    });
    const poolB = getSshPool(b);
    const auditB = getExecAuditLog(b);
    let closedB = 0;
    poolB.closeAll = async () => void closedB++;

    await closeSessionExecRuntime(a, jobsA);

    expect(jobsA.get(jobA.id)?.status).toBe('cancelled');
    expect(jobsA.isClosed).toBe(true);
    expect(jobsB.get(jobB.id)?.status).toBe('running');
    expect(jobsB.isClosed).toBe(false);
    // Ni las conexiones ni la auditoría de la otra sesión se han tocado.
    expect(closedB).toBe(0);
    expect(getSshPool(b)).toBe(poolB);
    expect(getExecAuditLog(b)).toBe(auditB);
    // La sesión B sigue pudiendo lanzar jobs.
    const again = await jobsB.start({ command: node('process.exit(0)'), cwd: dir, owner: main });
    expect(again.id).not.toBe(jobB.id);
  });

  it('la auditoría de cada sesión va a su fichero y se vacía al cerrarla', async () => {
    const a = sessionConfig('a');
    const b = sessionConfig('b');
    const jobsA = jobs(a);
    const jobsB = jobs(b);
    await jobsA.start({ command: node('setInterval(() => {}, 1000)'), cwd: dir, owner: main });
    await jobsB.start({ command: node('setInterval(() => {}, 1000)'), cwd: dir, owner: main });

    await closeSessionExecRuntime(a, jobsA);

    // El arranque y el cierre del job de A ya están en disco; nada de B se mezcló.
    const linesA = auditLines('a');
    expect(linesA.length).toBeGreaterThanOrEqual(2);
    await getExecAuditLog(b).flush();
    expect(auditLines('b')).toHaveLength(1);
  });

  it('el cierre del proceso cierra lo de todas las sesiones', async () => {
    const a = sessionConfig('a');
    const b = sessionConfig('b');
    const closed: string[] = [];
    getSshPool(a).closeAll = async () => void closed.push('a');
    getSshPool(b).closeAll = async () => void closed.push('b');

    await closeExecRuntime();

    expect(closed.sort()).toEqual(['a', 'b']);
  });
});
