import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execa } from 'execa';
import { StratumConfigSchema, type StratumConfig } from '../../config/schema.js';
import type { ToolContext, ToolResult } from '../../agent/types.js';
import { detectRuntime } from '../../box/runtime.js';
import { BOX_LABEL, boxContainerName } from '../../box/spec.js';
import { createExecTool } from './exec.js';
import { getExecAuditLog, resetExecRuntime } from './runtime.js';

/**
 * M13 — `exec` en `container:<caja>` contra un runtime de verdad (Podman o
 * Docker). Se salta si no hay ninguno, o si no está la imagen `alpine` en local:
 * el test no descarga nada. La «caja» es un alpine con las etiquetas de
 * Stratum; lo que se prueba es el backend, no la imagen.
 */
const detected = await detectRuntime('auto');
const bin = detected.ok ? detected.runtime.bin : null;
const hasAlpine =
  bin !== null &&
  (await execa(bin, ['image', 'inspect', 'alpine:latest'], { reject: false })).exitCode === 0;

const NAME = `itest-${process.pid}`;
const CONTAINER = boxContainerName(NAME);
const FOREIGN = `itest-foreign-${process.pid}`;

function config(dir: string, extra: Record<string, unknown> = {}): StratumConfig {
  return StratumConfigSchema.parse({
    tools: { auditLog: join(dir, 'audit.jsonl') },
    box: { enabled: true, name: NAME, runtime: detected.ok ? detected.runtime.kind : 'auto' },
    ...extra,
  });
}

const ctxOf = (cfg: StratumConfig, signal = new AbortController().signal): ToolContext => ({
  signal,
  cwd: process.cwd(),
  config: cfg,
});

async function run(
  cfg: StratumConfig,
  input: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<ToolResult> {
  const tool = createExecTool(cfg);
  const ctx = ctxOf(cfg, signal);
  const veto = tool.preflight?.(input, ctx);
  if (veto) return veto;
  return tool.execute(input, ctx);
}

const text = (r: ToolResult): string => (r.ok ? r.output : r.error);

async function processesInBox(): Promise<string> {
  return (await execa(bin!, ['exec', CONTAINER, 'ps', '-o', 'args'], { reject: false })).stdout;
}

describe.skipIf(!bin || !hasAlpine)('exec en container:<caja> (M13, runtime real)', () => {
  let dir: string;
  let cfg: StratumConfig;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'stratum-box-it-'));
    cfg = config(dir);
    await execa(bin!, ['rm', '-f', CONTAINER, boxContainerName(FOREIGN)], { reject: false });
    await execa(bin!, [
      'run',
      '-d',
      '--init',
      '--name',
      CONTAINER,
      '--label',
      `${BOX_LABEL}=${NAME}`,
      'alpine:latest',
      'sleep',
      'infinity',
    ]);
    // Un contenedor con nombre de caja pero sin la etiqueta: no es de Stratum.
    await execa(bin!, [
      'run',
      '-d',
      '--init',
      '--name',
      boxContainerName(FOREIGN),
      'alpine:latest',
      'sleep',
      'infinity',
    ]);
  }, 60_000);

  afterAll(async () => {
    await execa(bin!, ['rm', '-f', CONTAINER, boxContainerName(FOREIGN)], { reject: false });
    resetExecRuntime();
    rmSync(dir, { recursive: true, force: true });
  }, 60_000);

  it('ejecuta dentro: salida, exit code, stdin y cwd', async () => {
    const ok = await run(cfg, {
      target: `container:${NAME}`,
      command: 'read x; echo "got $x in $(pwd)"; cat /etc/alpine-release >/dev/null && echo alpine',
      stdin: 'hola\n',
      cwd: '/tmp',
    });
    expect(ok.ok).toBe(true);
    expect(text(ok)).toContain('got hola in /tmp');
    expect(text(ok)).toContain('alpine');
    expect(text(ok)).toContain(`target="container:${NAME}"`);
    expect(text(ok)).toContain('requestedCwd="/tmp"');

    const failed = await run(cfg, {
      target: `container:${NAME}`,
      command: 'echo oops >&2; exit 7',
    });
    expect(failed).toMatchObject({
      ok: false,
      recoverable: true,
      countsAsFailure: false,
      executed: true,
    });
    expect(text(failed)).toContain('exitCode="7"');
    expect(text(failed)).toContain('oops');
  }, 30_000);

  it('un cwd que no existe falla sin ejecutar el comando', async () => {
    const r = await run(cfg, { target: `container:${NAME}`, command: 'echo ran', cwd: '/nope' });
    expect(r.ok).toBe(false);
    expect(text(r)).not.toContain('ran');
    expect(text(r)).toContain('exitCode="1"');
  }, 30_000);

  it('maxBytes: conserva hasta el tope y deja terminar el comando', async () => {
    const r = await run(cfg, {
      target: `container:${NAME}`,
      command: 'head -c 5000 /dev/zero | tr "\\0" a; echo; echo done >&2',
      maxBytes: 100,
    });
    expect(text(r)).toContain('status="truncated"');
    expect(text(r)).toMatch(
      /OUTPUT TRUNCATED at 100 bytes; \d+ more bytes were discarded while the command ran/,
    );
  }, 30_000);

  it('timeout: mata el grupo de procesos DENTRO de la caja', async () => {
    const started = Date.now();
    const r = await run(cfg, {
      target: `container:${NAME}`,
      command: 'sleep 311 & sleep 312; echo never',
      timeout: 1500,
    });
    expect(text(r)).toContain('status="timeout"');
    expect(text(r)).toContain('exitCode="unknown"');
    expect(Date.now() - started).toBeLessThan(10_000);
    await new Promise((res) => setTimeout(res, 500));
    const ps = await processesInBox();
    expect(ps).not.toContain('sleep 311');
    expect(ps).not.toContain('sleep 312');
  }, 30_000);

  it('cancelar: resuelve cancelled y no deja el comando vivo', async () => {
    const ac = new AbortController();
    const pending = run(cfg, { target: `container:${NAME}`, command: 'sleep 321' }, ac.signal);
    await new Promise((res) => setTimeout(res, 1500));
    ac.abort();
    const r = await pending;
    expect(text(r)).toContain('status="cancelled"');
    await new Promise((res) => setTimeout(res, 500));
    expect(await processesInBox()).not.toContain('sleep 321');
  }, 30_000);

  it('auditoría: cada ejecución queda con su target', async () => {
    await run(cfg, { target: `container:${NAME}`, command: 'echo audited' });
    await getExecAuditLog(cfg).flush();
    const records = readFileSync(join(dir, 'audit.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { target: string; command: string; status: string });
    expect(records).toContainEqual(
      expect.objectContaining({
        target: `container:${NAME}`,
        command: 'echo audited',
        status: 'exited',
      }),
    );
  }, 30_000);

  it('falla cerrado: contenedor ajeno o caja parada → connect_error, nunca local', async () => {
    const foreign = config(dir, {
      box: { enabled: true, name: FOREIGN, runtime: detected.ok ? detected.runtime.kind : 'auto' },
    });
    const r1 = await run(foreign, { target: `container:${FOREIGN}`, command: 'echo $HOSTNAME' });
    expect(r1.ok).toBe(false);
    expect(text(r1)).toContain('was not created by Stratum');

    await execa(bin!, ['stop', '-t', '1', CONTAINER]);
    try {
      const r2 = await run(cfg, { target: `container:${NAME}`, command: 'echo ran' });
      expect(r2.ok).toBe(false);
      expect(text(r2)).toContain('is stopped');
      expect(text(r2)).not.toContain('ran');
    } finally {
      await execa(bin!, ['start', CONTAINER]);
    }
  }, 60_000);
});
