/**
 * Modo código de Stratum Desktop — el diff de **un** fichero del working tree
 * frente a `HEAD`, para enseñarlo a un cliente (`git.diff` del daemon).
 *
 * Lo que no se negocia:
 *  - **La ruta se confina y falla cerrado.** Es relativa a la raíz del repo tal
 *    como la dio `git.changes`; absoluta, con `..`, con NUL o que resuelva
 *    (`realpath`) fuera de la raíz es un rechazo, y una comprobación que lanza
 *    también (`confinePath`).
 *  - **git con argumentos fijos**: `execa` sin shell, `--` antes de la ruta,
 *    `scrubGitEnv()` (un `GIT_DIR` heredado mediría otro repo), sin diff externo
 *    ni `textconv` (ejecutarían lo que diga la config del repo), sin color.
 *  - **Los secretos se redactan antes de recortar** (`redactSecrets`): un PEM
 *    cortado dejaría de casar. Después se recorta en un límite de línea al tope
 *    del protocolo, medido como viaja (texto escapado en JSON).
 *  - Un untracked sale entero como añadido, con los topes de `changes.ts`
 *    (más de 2 MB o con un byte NUL → `binary`, sin texto).
 */
import { execa } from 'execa';
import { readFile, stat } from 'fs/promises';
import { isAbsolute, join, posix, win32 } from 'path';
import { confinePath } from '../tools/fs/confine.js';
import { redactSecrets, type ExtraRedaction } from '../security/redact-output.js';
import { parseNumstat, parsePorcelain, UNTRACKED_MAX_BYTES } from './changes.js';
import { scrubGitEnv } from './env.js';

export interface FileDiff {
  diff: string;
  truncated: boolean;
  binary: boolean;
}

export type FileDiffResult =
  | ({ ok: true } & FileDiff)
  | { ok: false; reason: 'invalid-path' | 'not-a-repo'; message: string };

export interface FileDiffOptions {
  /** Tope del diff, en bytes tal como viaja (JSON). */
  maxBytes: number;
  /** Literales extra de la config de la sesión (`tools.redaction.extraPatterns`). */
  extraRedactions?: readonly ExtraRedaction[];
}

/** Lo que se lee de la salida de git como mucho: lo demás no llegaría a enseñarse. */
const MAX_GIT_OUTPUT_BYTES = 8 * 1024 * 1024;

/**
 * `-c core.fsmonitor=false`: un repo ajeno no ejecuta su monitor de ficheros al
 * pedirle el diff. Lo demás que podría ejecutar código (diff externo,
 * `textconv`) se apaga en cada orden.
 */
const GIT_SAFE = ['-c', 'core.fsmonitor=false'];

async function git(cwd: string, args: string[]): Promise<string | null> {
  try {
    const result = await execa('git', [...GIT_SAFE, ...args], {
      cwd,
      reject: false,
      stripFinalNewline: false,
      env: scrubGitEnv(),
      extendEnv: false,
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
    });
    // Recortada por `maxBuffer`: lo que llegó vale (se recorta después igualmente).
    if (result.exitCode !== 0 && !result.isMaxBuffer) return null;
    return typeof result.stdout === 'string' ? result.stdout : null;
  } catch {
    return null;
  }
}

/**
 * Rechazos sintácticos antes de tocar el disco: vacía, con NUL, absoluta (en
 * cualquiera de las dos sintaxis) o con un segmento `..`.
 */
export function diffPathProblem(path: string): string | null {
  if (path.length === 0) return 'the path is empty';
  if (path.includes('\0')) return 'the path contains a NUL byte';
  if (isAbsolute(path) || posix.isAbsolute(path) || win32.isAbsolute(path)) {
    return 'the path must be relative to the repository root';
  }
  if (/^[a-zA-Z]:/.test(path)) return 'the path must be relative to the repository root';
  if (path.split(/[\\/]/).some((segment) => segment === '..')) {
    return 'the path cannot contain ".."';
  }
  return null;
}

/**
 * Diff de `path` (relativa a la raíz del repo de `cwd`). Nunca lanza: una ruta
 * que no vale o un `cwd` que no es un repo vuelven como `ok: false`.
 */
export async function collectFileDiff(
  cwd: string,
  path: string,
  opts: FileDiffOptions,
): Promise<FileDiffResult> {
  const inside = await git(cwd, ['rev-parse', '--is-inside-work-tree']);
  if (inside === null || inside.trim() !== 'true') {
    return {
      ok: false,
      reason: 'not-a-repo',
      message: 'The session directory is not a git repository.',
    };
  }
  const top = (await git(cwd, ['rev-parse', '--show-toplevel']))?.trim();
  if (!top) {
    return {
      ok: false,
      reason: 'not-a-repo',
      message: 'The session directory is not a git repository.',
    };
  }
  const invalid = (why: string): FileDiffResult => ({
    ok: false,
    reason: 'invalid-path',
    message: `Invalid path: ${why}.`,
  });
  const problem = diffPathProblem(path);
  if (problem) return invalid(problem);
  let relative: string;
  try {
    const confined = confinePath({ root: top }, path, 'read');
    if (!confined.ok) return invalid(confined.reason);
    if (confined.relative === '') return invalid('the path is the repository root');
    relative = confined.relative;
  } catch {
    // Falla cerrado: lo que no se pudo comprobar no se lee.
    return invalid('it could not be checked safely');
  }

  const status = parsePorcelain(
    (await git(top, ['status', '--porcelain', '-z', '-uall', '--', relative])) ?? '',
  ).find((entry) => entry.path === relative);
  const hasHead = (await git(top, ['rev-parse', '--verify', '--quiet', 'HEAD'])) !== null;

  let raw: FileDiff;
  if (status?.status === 'untracked' || !hasHead) {
    // git no tiene con qué compararlo: el fichero entero es lo añadido.
    raw = await wholeFileAsAdded(top, relative);
  } else {
    raw = await trackedDiff(top, relative);
  }
  if (raw.binary) return { ok: true, diff: '', truncated: false, binary: true };
  const redacted = redactSecrets(raw.diff, opts.extraRedactions ?? []).text;
  const bounded = truncateAtLine(redacted, opts.maxBytes);
  return {
    ok: true,
    diff: bounded.text,
    truncated: raw.truncated || bounded.truncated,
    binary: false,
  };
}

async function trackedDiff(root: string, relative: string): Promise<FileDiff> {
  const base = ['diff', '--no-ext-diff', '--no-textconv', '--no-color', 'HEAD'];
  const numstat = parseNumstat((await git(root, [...base, '--numstat', '--', relative])) ?? '');
  if (numstat.some((entry) => entry.binary)) return { diff: '', truncated: false, binary: true };
  const text = (await git(root, [...base, '--', relative])) ?? '';
  return {
    diff: text,
    truncated: Buffer.byteLength(text) >= MAX_GIT_OUTPUT_BYTES,
    binary: false,
  };
}

async function wholeFileAsAdded(root: string, relative: string): Promise<FileDiff> {
  const full = join(root, relative);
  let content: Buffer;
  try {
    const info = await stat(full);
    if (!info.isFile()) return { diff: '', truncated: false, binary: false };
    if (info.size > UNTRACKED_MAX_BYTES) return { diff: '', truncated: false, binary: true };
    content = await readFile(full);
  } catch {
    // Desapareció entre el status y la lectura: no hay nada que enseñar.
    return { diff: '', truncated: false, binary: false };
  }
  if (content.includes(0)) return { diff: '', truncated: false, binary: true };
  return {
    diff: addedFileDiff(relative, content.toString('utf8')),
    truncated: false,
    binary: false,
  };
}

/** Un fichero nuevo como diff unificado, como lo escribiría `git diff --no-index`. */
export function addedFileDiff(relative: string, text: string): string {
  const header = [
    `diff --git a/${relative} b/${relative}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${relative}`,
  ];
  if (text === '') return `${header.join('\n')}\n`;
  const lines = text.split('\n');
  const endsWithNewline = lines[lines.length - 1] === '';
  if (endsWithNewline) lines.pop();
  const body = lines.map((line) => `+${line}`);
  if (!endsWithNewline) body.push('\\ No newline at end of file');
  return `${[...header, `@@ -0,0 +1,${lines.length} @@`, ...body].join('\n')}\n`;
}

/**
 * Recorta `text` a `maxBytes` medidos como viajan (cada línea escapada en
 * JSON), siempre tras un salto de línea. Una sola línea que ya no cabe se deja
 * fuera entera: nunca se parte.
 */
export function truncateAtLine(
  text: string,
  maxBytes: number,
): { text: string; truncated: boolean } {
  if (wireBytes(text) <= maxBytes) return { text, truncated: false };
  let used = 0;
  let end = 0;
  while (end < text.length) {
    const next = text.indexOf('\n', end);
    const stop = next === -1 ? text.length : next + 1;
    const cost = wireBytes(text.slice(end, stop));
    if (used + cost > maxBytes) break;
    used += cost;
    end = stop;
  }
  return { text: text.slice(0, end), truncated: true };
}

/** Bytes de `text` dentro de una cadena JSON (sin las comillas). */
function wireBytes(text: string): number {
  return Buffer.byteLength(JSON.stringify(text)) - 2;
}
