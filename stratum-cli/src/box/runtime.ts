/**
 * M13 — el runtime de contenedores de la caja: Podman (preferido, no necesita
 * un servicio en Linux) o Docker. Stratum lo detecta; no lo instala.
 *
 * Solo este módulo y `manager.ts` lanzan el binario, siempre con argumentos
 * fijos y con execa (nunca un shell que los interprete).
 */
import { execa } from 'execa';
import type { BoxConfig } from '../config/schema.js';
import type { RuntimeKind } from './spec.js';

export interface ContainerRuntime {
  kind: RuntimeKind;
  /** Ejecutable a lanzar (`podman`, `docker`), resuelto por el PATH. */
  bin: string;
}

export type RuntimeDetection =
  | { ok: true; runtime: ContainerRuntime }
  | { ok: false; reason: string };

export interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/** Lanza `<bin> <args>` y devuelve su resultado. Nunca rechaza por exit ≠ 0. */
export type RuntimeRunner = (
  bin: string,
  args: string[],
  opts?: { timeoutMs?: number; onOutput?: (line: string) => void },
) => Promise<RunResult>;

export const defaultRunner: RuntimeRunner = async (bin, args, opts = {}) => {
  const child = execa(bin, args, {
    reject: false,
    stdin: 'ignore',
    windowsHide: true,
    ...(opts.timeoutMs !== undefined ? { timeout: opts.timeoutMs } : {}),
  });
  if (opts.onOutput) {
    const emit = (chunk: Buffer | string): void => {
      for (const line of String(chunk).split(/\r?\n/)) if (line.trim()) opts.onOutput!(line);
    };
    child.stdout?.on('data', emit);
    child.stderr?.on('data', emit);
  }
  const result = await child;
  // Sin exit code: no llegó a arrancar (binario ausente) o venció el plazo.
  return {
    exitCode: typeof result.exitCode === 'number' ? result.exitCode : null,
    stdout: String(result.stdout ?? ''),
    stderr: String(result.stderr ?? result.shortMessage ?? ''),
  };
};

const PROBE_TIMEOUT_MS = 10_000;

/** ¿Responde `<bin> version`? Con Docker, también exige que su servicio esté vivo. */
async function probe(bin: string, run: RuntimeRunner): Promise<boolean> {
  const r = await run(bin, ['version'], { timeoutMs: PROBE_TIMEOUT_MS });
  return r.exitCode === 0;
}

const CANDIDATES: Record<BoxConfig['runtime'], RuntimeKind[]> = {
  auto: ['podman', 'docker'],
  podman: ['podman'],
  docker: ['docker'],
};

export async function detectRuntime(
  preference: BoxConfig['runtime'],
  run: RuntimeRunner = defaultRunner,
): Promise<RuntimeDetection> {
  const kinds = CANDIDATES[preference];
  for (const kind of kinds) {
    if (await probe(kind, run)) return { ok: true, runtime: { kind, bin: kind } };
  }
  const names = kinds.map((k) => (k === 'podman' ? 'Podman' : 'Docker')).join(' or ');
  return {
    ok: false,
    reason:
      `No container runtime available: ${names} is not installed or not running` +
      (preference === 'auto' ? '' : ` (box.runtime is "${preference}")`) +
      '. Install one to use the box.',
  };
}

/**
 * Detección cacheada para el camino caliente (`exec` en `container:`): un
 * acierto vale un minuto; un fallo se repite en cada llamada, para que arrancar
 * el runtime se note en el acto.
 */
const DETECTION_TTL_MS = 60_000;
const cache = new Map<BoxConfig['runtime'], { at: number; runtime: ContainerRuntime }>();

export async function cachedRuntime(
  preference: BoxConfig['runtime'],
  now: () => number = Date.now,
): Promise<RuntimeDetection> {
  const hit = cache.get(preference);
  if (hit && now() - hit.at < DETECTION_TTL_MS) return { ok: true, runtime: hit.runtime };
  const detected = await detectRuntime(preference);
  if (detected.ok) cache.set(preference, { at: now(), runtime: detected.runtime });
  else cache.delete(preference);
  return detected;
}

/** Solo para tests. */
export function resetRuntimeCache(): void {
  cache.clear();
}
