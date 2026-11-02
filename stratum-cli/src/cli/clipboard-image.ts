/**
 * Lee la imagen del portapapeles del sistema (Alt+V / Ctrl+V en `chat`).
 *
 * Sin dependencias nativas: llama a la herramienta del SO con `execa` (nunca
 * `child_process`), con argumentos y scripts fijos y sin shell. Nada del
 * usuario se interpola en un script: la ruta del temporal viaja por una
 * variable de entorno. Herramienta ausente o portapapeles sin imagen → `null`;
 * decidir si lo leído es una imagen válida (tipo, tamaño) es de `saveUserImage`.
 */
import { execa } from 'execa';
import { randomBytes } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface ClipboardRunResult {
  exitCode: number | undefined;
  stdout: Uint8Array;
}

export interface ClipboardDeps {
  /** Ejecuta `file args` sin shell. Devuelve el resultado aunque el código sea ≠ 0; lanza si el binario no existe. */
  run?: (
    file: string,
    args: readonly string[],
    opts: { env?: Record<string, string> },
  ) => Promise<ClipboardRunResult>;
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  /** Ruta de un temporal nuevo (Windows y el respaldo de macOS). */
  tempPath?: () => string;
  readFile?: (path: string) => Promise<Uint8Array>;
  removeFile?: (path: string) => Promise<void>;
}

/** Plazo de cada herramienta: un portapapeles no tarda. */
const TIMEOUT_MS = 8000;

const WINDOWS_SCRIPT = [
  'Add-Type -AssemblyName System.Windows.Forms',
  'Add-Type -AssemblyName System.Drawing',
  '$img = [System.Windows.Forms.Clipboard]::GetImage()',
  'if ($null -eq $img) { exit 3 }',
  '$img.Save($env:STRATUM_CLIP_OUT, [System.Drawing.Imaging.ImageFormat]::Png)',
  '$img.Dispose()',
].join('; ');

const MAC_SCRIPT = [
  'set outPath to (system attribute "STRATUM_CLIP_OUT")',
  'try',
  'set png to the clipboard as «class PNGf»',
  'on error',
  'error number 3',
  'end try',
  'set f to open for access (POSIX file outPath) with write permission',
  'set eof f to 0',
  'write png to f',
  'close access f',
].join('\n');

const defaultRun: NonNullable<ClipboardDeps['run']> = async (file, args, opts) => {
  const r = await execa(file, [...args], {
    encoding: 'buffer',
    reject: false,
    timeout: TIMEOUT_MS,
    stdin: 'ignore',
    ...(opts.env ? { env: opts.env, extendEnv: false } : {}),
    windowsHide: true,
  });
  // `reject: false` no cubre el binario inexistente: `failed` y sin código.
  if (r.failed && r.exitCode === undefined) throw new Error(r.shortMessage);
  return { exitCode: r.exitCode, stdout: r.stdout as unknown as Uint8Array };
};

const defaultTempPath = () => join(tmpdir(), `stratum-clip-${randomBytes(6).toString('hex')}.png`);

function cleanEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined) out[k] = v;
  return out;
}

/** Bytes del portapapeles si hay una imagen; `null` si no la hay o no se pudo leer. */
export async function readClipboardImage(deps: ClipboardDeps = {}): Promise<Uint8Array | null> {
  const run = deps.run ?? defaultRun;
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const tempPath = deps.tempPath ?? defaultTempPath;
  const read = deps.readFile ?? ((p: string) => readFile(p));
  const remove = deps.removeFile ?? ((p: string) => rm(p, { force: true }));

  /** Ejecuta y devuelve stdout, o `null` ante binario ausente / código ≠ 0 / salida vacía. */
  const stdoutOf = async (file: string, args: string[]): Promise<Uint8Array | null> => {
    try {
      const r = await run(file, args, {});
      return r.exitCode === 0 && r.stdout.length > 0 ? r.stdout : null;
    } catch {
      return null;
    }
  };

  /** Ejecuta una herramienta que escribe un PNG en el temporal; lo lee y lo borra. */
  const viaTempFile = async (file: string, args: string[]): Promise<Uint8Array | null> => {
    const out = tempPath();
    try {
      const r = await run(file, args, { env: { ...cleanEnv(env), STRATUM_CLIP_OUT: out } });
      if (r.exitCode !== 0) return null;
      const bytes = await read(out);
      return bytes.length > 0 ? bytes : null;
    } catch {
      return null;
    } finally {
      await remove(out).catch(() => undefined);
    }
  };

  if (platform === 'win32') {
    return viaTempFile('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-STA',
      '-Command',
      WINDOWS_SCRIPT,
    ]);
  }
  if (platform === 'darwin') {
    return (
      (await stdoutOf('pngpaste', ['-'])) ?? (await viaTempFile('osascript', ['-e', MAC_SCRIPT]))
    );
  }
  if (env.WAYLAND_DISPLAY) return stdoutOf('wl-paste', ['--type', 'image/png']);
  return stdoutOf('xclip', ['-selection', 'clipboard', '-t', 'image/png', '-o']);
}
