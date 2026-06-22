import { getAsciiArt, getAsciiArtWidth } from './ascii-art.js';

const COLUMNS_PER_FRAME = 2;
const WINDOWS_FRAME_DELAY_MS = 40;
const OTHER_FRAME_DELAY_MS = 32;

const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';
const RESET_STYLE = '\x1b[0m';
const LOGO_COLOR = '\x1b[38;2;245;158;11m';

export interface StartupLogoStdout {
  isTTY?: boolean;
  columns?: number;
  rows?: number;
  write(data: string): boolean | void;
}

export type StartupLogoEnvironment = Record<string, string | undefined>;
export type StartupLogoSleep = (milliseconds: number, signal?: AbortSignal) => Promise<void>;

export interface StartupLogoAnimationOptions {
  stdout: StartupLogoStdout;
  env?: StartupLogoEnvironment;
  platform?: NodeJS.Platform;
  sleep?: StartupLogoSleep;
  signal?: AbortSignal;
}

function isEnabledEnvironmentFlag(value: string | undefined): boolean {
  return value !== undefined && value !== '' && value !== '0' && value.toLowerCase() !== 'false';
}

export function supportsStartupLogoAnimation(
  stdout: StartupLogoStdout,
  env: StartupLogoEnvironment,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (stdout.isTTY !== true) return false;
  if (env['TERM']?.toLowerCase() === 'dumb') return false;
  if (isEnabledEnvironmentFlag(env['CI'])) return false;
  if (env['STRATUM_NO_ANIMATION'] === '1') return false;
  if (platform === 'win32' && !env['WT_SESSION']) return false;

  const columns = stdout.columns;
  const terminalRows = stdout.rows;
  if (!Number.isInteger(columns) || !Number.isInteger(terminalRows)) return false;
  if ((columns ?? 0) <= 0 || (terminalRows ?? 0) <= 0) return false;

  const art = getAsciiArt(columns!);
  const artRows = art.split('\n');
  return getAsciiArtWidth(art) <= columns! && artRows.length < terminalRows!;
}

function cursorUp(rows: number): string {
  return rows > 0 ? `\x1b[${rows}A` : '';
}

function cursorDown(rows: number): string {
  return rows > 0 ? `\x1b[${rows}B` : '';
}

function buildFrame(artRows: string[], fromColumn: number, toColumn: number): string {
  const frame: string[] = [];

  for (let rowIndex = 0; rowIndex < artRows.length; rowIndex += 1) {
    if (rowIndex > 0) frame.push('\x1b[1B');
    frame.push(`\x1b[${fromColumn + 1}G`);
    frame.push(artRows[rowIndex]!.slice(fromColumn, toColumn));
  }

  frame.push(cursorUp(artRows.length - 1), '\r');
  return frame.join('');
}

const defaultSleep: StartupLogoSleep = (milliseconds, signal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Startup logo animation cancelled'));
      return;
    }

    const timeout = setTimeout(finish, milliseconds);

    function cleanup() {
      signal?.removeEventListener('abort', cancel);
    }

    function finish() {
      cleanup();
      resolve();
    }

    function cancel() {
      clearTimeout(timeout);
      cleanup();
      reject(new Error('Startup logo animation cancelled'));
    }

    signal?.addEventListener('abort', cancel, { once: true });
  });

/**
 * Renders the startup logo before Ink mounts. Returns true when a complete logo
 * was left on stdout, so Ink must not render it again.
 */
export async function animateStartupLogo({
  stdout,
  env = process.env,
  platform = process.platform,
  sleep = defaultSleep,
  signal,
}: StartupLogoAnimationOptions): Promise<boolean> {
  if (!supportsStartupLogoAnimation(stdout, env, platform)) return false;

  const art = getAsciiArt(stdout.columns!);
  const artRows = art.split('\n');
  const width = getAsciiArtWidth(art);
  const frameDelay = platform === 'win32' ? WINDOWS_FRAME_DELAY_MS : OTHER_FRAME_DELAY_MS;
  let nextColumn = 0;
  let regionReserved = false;

  try {
    stdout.write(`${HIDE_CURSOR}${LOGO_COLOR}\r${'\n'.repeat(artRows.length)}${cursorUp(artRows.length)}\r`);
    regionReserved = true;

    try {
      while (nextColumn < width) {
        if (signal?.aborted) throw new Error('Startup logo animation cancelled');

        const frameEnd = Math.min(nextColumn + COLUMNS_PER_FRAME, width);
        stdout.write(buildFrame(artRows, nextColumn, frameEnd));
        nextColumn = frameEnd;

        if (nextColumn < width) await sleep(frameDelay, signal);
      }
    } catch {
      // Cancellation or timer errors fall back to completing the reserved logo
      // in one additive write. Already visible columns are never reprinted.
      if (nextColumn < width) {
        stdout.write(buildFrame(artRows, nextColumn, width));
        nextColumn = width;
      }
    }

    return nextColumn === width;
  } catch {
    return false;
  } finally {
    try {
      const belowLogo = regionReserved ? `${cursorDown(artRows.length)}\r` : '';
      stdout.write(`${RESET_STYLE}${belowLogo}${SHOW_CURSOR}`);
    } catch {
      // stdout failures must not prevent Ink from starting with its static fallback.
    }
  }
}
