/**
 * M18 parte 6E — `send_image`: el `companion` enseña una imagen en el chat (la
 * conversación de Dot y los chats emparejados de Telegram), `docs/PRD_STRATUM_DOT.md`
 * §23.11. Es la **única** vía por la que sale una imagen: las capturas de las
 * `screen_*` no salen solas (decidido por el usuario: el modelo elige qué enseña).
 *
 * De dónde: un fichero de `/exchange` (la carpeta compartida con la caja) o la
 * pantalla actual de la caja. Nada más del anfitrión. La imagen se copia al
 * almacén de compartidas (`images/shared.ts`) y viaja como `ToolResult.shared`:
 * el loop la anuncia (`image_shared`) y la conversación lleva solo su id.
 *
 * Riesgo aceptado (PRD): una imagen no se puede redactar como el texto, así que
 * lo que salga en ella llega al chat. A la traza y a los logs, solo metadatos.
 */
import { realpathSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, posix, relative } from 'node:path';
import { z } from 'zod';
import type { ToolContext, ToolDefinition, ToolResult } from '../../agent/types.js';
import { USER_IMAGE_LIMITS } from '../../agent/user-images.js';
import { BOX_EXCHANGE } from '../../box/spec.js';
import { saveSharedImage } from '../../images/shared.js';
import { UserImageError } from '../../images/store.js';
import { ExecConnectError, isHandedOver } from '../exec/backend.js';
import { containerBackend } from '../exec/backends/container.js';
import type { ExecutionTarget } from '../exec/target.js';
import { pngImage } from '../screen/geometry.js';

export const SEND_IMAGE_TOOL = 'send_image';

/** Lo que cabe en el pie de una foto de Telegram. */
export const CAPTION_MAX_CHARS = 1000;
const CAPTURE_TIMEOUT_MS = 30_000;

const schema = z.object({
  path: z
    .string()
    .max(1024)
    .optional()
    .describe(`An image file in ${BOX_EXCHANGE} (e.g. "${BOX_EXCHANGE}/chart.png").`),
  screen: z
    .boolean()
    .optional()
    .describe("true to send what your box's screen shows right now, instead of a file."),
  caption: z
    .string()
    .max(CAPTION_MAX_CHARS)
    .optional()
    .describe('A short text shown with the image.'),
});

function recoverable(error: string): ToolResult {
  return { ok: false, error, recoverable: true };
}

export interface SendImageOptions {
  /** La carpeta del anfitrión montada en `/exchange`. */
  exchangeDir: string;
  /** El almacén de las imágenes enviadas. */
  sharedDir: string;
  /** La caja con escritorio, si la hay: sin ella no hay `screen`. */
  screen: (ExecutionTarget & { kind: 'container' }) | null;
  now?: () => number;
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * La ruta del anfitrión de un fichero de `/exchange`, confinada por `realpath`
 * (un enlace que salga de la carpeta no vale). Admite la ruta de la caja
 * (`/exchange/a.png`) o una relativa a `/exchange`.
 */
export function exchangeFile(path: string, exchangeDir: string): string | ToolResult {
  const p = posix.normalize(path.replaceAll('\\', '/'));
  const rel =
    p === BOX_EXCHANGE
      ? ''
      : p.startsWith(`${BOX_EXCHANGE}/`)
        ? p.slice(BOX_EXCHANGE.length + 1)
        : p;
  if (rel === '' || posix.isAbsolute(rel) || rel.split('/').includes('..')) {
    return recoverable(
      `Only image files inside ${BOX_EXCHANGE} can be sent (e.g. ${BOX_EXCHANGE}/chart.png).`,
    );
  }
  let real: string;
  let root: string;
  try {
    root = realpathSync(exchangeDir);
    real = realpathSync(join(exchangeDir, rel));
  } catch {
    return recoverable(`${BOX_EXCHANGE}/${rel}: file not found.`);
  }
  if (!inside(root, real)) {
    return recoverable(`Only image files inside ${BOX_EXCHANGE} can be sent.`);
  }
  return real;
}

async function captureScreen(
  target: ExecutionTarget & { kind: 'container' },
  ctx: ToolContext,
): Promise<Uint8Array | ToolResult> {
  let outcome;
  try {
    outcome = await containerBackend.run(
      target,
      {
        command: 'export DISPLAY="${DISPLAY:-:99}"; import -window root png:- | base64 -w0',
        timeoutMs: CAPTURE_TIMEOUT_MS,
        // El PNG en base64 pesa un tercio más.
        maxBytes: Math.ceil((USER_IMAGE_LIMITS.maxBytes * 4) / 3) + 1024,
        signal: ctx.signal,
      },
      ctx,
    );
  } catch (err) {
    if (err instanceof ExecConnectError) return recoverable(err.message);
    return recoverable(`Could not reach the box screen: ${(err as Error).message}`);
  }
  if (isHandedOver(outcome)) return recoverable('The box screen command did not finish.');
  if (outcome.status === 'cancelled')
    return { ok: false, error: 'Cancelled by the user.', recoverable: false };
  if (outcome.status === 'timeout') return recoverable('The box screen did not answer in time.');
  if (outcome.status === 'truncated') return recoverable('The screenshot is larger than 5 MB.');
  if (outcome.exitCode !== 0) {
    return recoverable(
      `The box screen failed: ${outcome.stderr.trim().slice(0, 300) || `exit code ${outcome.exitCode ?? 'unknown'}`}.`,
    );
  }
  try {
    return Buffer.from(pngImage(outcome.stdout).data, 'base64');
  } catch (err) {
    return recoverable(`Could not read the screenshot: ${(err as Error).message}.`);
  }
}

export function createSendImageTool(opts: SendImageOptions): ToolDefinition {
  return {
    name: SEND_IMAGE_TOOL,
    description:
      'Show an image to the user in the chat (Dot and their paired Telegram chat). Send a PNG, ' +
      `JPEG, WebP or GIF file of up to 5 MB from ${BOX_EXCHANGE} (save it there first, e.g. a ` +
      'chart or a page screenshot), or screen: true for what your box screen shows now. ' +
      'Screenshots from the screen_* tools are only for you: the user sees an image only when ' +
      'you send it with this tool. Whatever is in the image reaches the user as is.',
    schema,
    destructive: false,
    timeout: CAPTURE_TIMEOUT_MS + 10_000,
    structuredCancellation: true,
    async execute(params, ctx) {
      const input = schema.parse(params);
      if ((input.path === undefined) === (input.screen !== true)) {
        return recoverable('Give either path (a file in /exchange) or screen: true, not both.');
      }
      let bytes: Uint8Array;
      let from: string;
      if (input.screen) {
        if (!opts.screen) return recoverable('Your box has no screen to send.');
        const shot = await captureScreen(opts.screen, ctx);
        if (!(shot instanceof Uint8Array)) return shot;
        bytes = shot;
        from = 'the box screen';
      } else {
        const file = exchangeFile(input.path!, opts.exchangeDir);
        if (typeof file !== 'string') return file;
        const st = statSync(file);
        if (!st.isFile()) return recoverable(`${input.path}: not a file.`);
        // Antes de leer: un fichero enorme no se carga para rechazarlo.
        if (st.size > USER_IMAGE_LIMITS.maxBytes) {
          return recoverable(`${input.path} is larger than 5 MB: make it smaller first.`);
        }
        bytes = readFileSync(file);
        from = input.path!;
      }
      let saved;
      try {
        saved = saveSharedImage(bytes, {
          dir: opts.sharedDir,
          ...(opts.now ? { now: opts.now() } : {}),
        });
      } catch (err) {
        if (err instanceof UserImageError) return recoverable(`${from}: ${err.message}`);
        throw err;
      }
      const caption = input.caption?.trim();
      return {
        ok: true,
        output: `Sent the image from ${from} to the chat (${saved.mime}, ${Math.round(saved.bytes / 1024)} KB).`,
        shared: { ...saved, ...(caption ? { caption } : {}) },
      };
    },
  };
}
