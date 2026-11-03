import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { ToolDefinition, ToolContext, ToolResult } from '../../agent/types.js';
import { sniffImageMime, type UserImageMime } from '../../agent/user-images.js';
import {
  IMAGE_SIZE_PATTERN,
  type ImageGenerationConfig,
  type StratumConfig,
} from '../../config/schema.js';
import { redactText } from '../../security/redact-output.js';

/**
 * `generate_image` — el asistente genera imágenes con el modelo de imágenes
 * declarado en `imageGeneration` (`POST <baseUrl>/images/generations`, la API
 * OpenAI-compatible). Solo se registra con esa sección y un workspace: deja
 * cada imagen en `outputs/`, que Desktop enseña en el chat.
 *
 * El modelo de chat escribe la petición (el prompt detallado, el tamaño, el
 * número de imágenes); esta tool solo la manda y guarda lo que vuelve. La
 * salida empieza por las rutas guardadas, una por línea: el protocolo recorta
 * la salida publicada y Desktop las lee de ahí.
 */

export const GENERATE_IMAGE_TOOL = 'generate_image';

/** Una imagen generada no puede pesar más (base64 o descargada). */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_IMAGES = 4;
const OUTPUTS_DIR = 'outputs';

const EXT: Record<UserImageMime, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

const schema = z.object({
  prompt: z
    .string()
    .min(1)
    .max(4000)
    .describe(
      'Detailed description of the image to generate, in English: subject, setting, composition, ' +
        'style or medium, lighting, colours and mood. Write it as one rich descriptive paragraph.',
    ),
  size: z
    .string()
    .regex(IMAGE_SIZE_PATTERN)
    .optional()
    .describe(
      'WIDTHxHEIGHT in pixels, e.g. 1024x1024, 1024x768, 768x1024. Default: configured size.',
    ),
  n: z
    .number()
    .int()
    .min(1)
    .max(MAX_IMAGES)
    .optional()
    .describe(`Number of images (1-${MAX_IMAGES}, default 1)`),
  name: z
    .string()
    .max(60)
    .optional()
    .describe('Short descriptive file name without extension, e.g. "zorro-acuarela"'),
});

interface ImageEndpoint {
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** A qué provider y modelo se piden las imágenes, o `null` si no hay forma. */
export function resolveImageEndpoint(config: StratumConfig): ImageEndpoint | null {
  const img: ImageGenerationConfig | undefined = config.imageGeneration;
  if (!img) return null;
  const name = img.provider ?? config.provider?.default;
  const provider = name ? config.provider?.providers[name] : undefined;
  if (!provider) return null;
  return {
    baseUrl: provider.baseUrl.replace(/\/+$/, ''),
    apiKey: provider.apiKey,
    model: img.model,
  };
}

/**
 * Marca de una llamada en el nombre de sus ficheros: la conversación publicada
 * no lleva la salida de las tools, pero sí su `callId`, y así Desktop encuentra
 * las imágenes de un turno antiguo en `outputs/`. Misma regla que
 * `callImageTag` de `stratum-desktop/src/components/chat/files/GeneratedImages.tsx`.
 */
export function callImageTag(callId: string | undefined): string {
  return (callId ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(-10);
}

/**
 * Nombre de fichero seguro a partir de lo que propone el modelo:
 * `<slug>-<marca>`, o `<slug>-<fecha>` sin `callId`.
 */
export function imageFileStem(
  name: string | undefined,
  callId: string | undefined,
  now: number,
): string {
  const slug = (name ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  const tag =
    callImageTag(callId) || new Date(now).toISOString().slice(0, 19).replace(/[-:T]/g, '');
  return `${slug || 'imagen'}-${tag}`;
}

function fail(error: string, countsAsFailure = true): ToolResult {
  return { ok: false, error, recoverable: true, ...(countsAsFailure ? {} : { countsAsFailure }) };
}

async function readImage(
  item: { b64_json?: unknown; url?: unknown },
  signal: AbortSignal,
): Promise<Uint8Array> {
  if (typeof item.b64_json === 'string' && item.b64_json.length > 0) {
    if ((item.b64_json.length * 3) / 4 > MAX_IMAGE_BYTES) throw new Error('image too large');
    return Buffer.from(item.b64_json, 'base64');
  }
  if (typeof item.url === 'string' && /^https?:\/\//i.test(item.url)) {
    // La URL la da el provider (almacenamiento firmado): se descarga sin
    // cabeceras propias, la `apiKey` nunca sale de la petición al provider.
    const res = await fetch(item.url, { signal });
    if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
    const declared = Number(res.headers.get('content-length') ?? 0);
    if (declared > MAX_IMAGE_BYTES) throw new Error('image too large');
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length > MAX_IMAGE_BYTES) throw new Error('image too large');
    return bytes;
  }
  throw new Error('the response has neither b64_json nor url');
}

function saveImage(dir: string, stem: string, bytes: Uint8Array): string {
  const mime = sniffImageMime(bytes);
  if (!mime) throw new Error('the provider did not return a PNG, JPEG, WebP or GIF image');
  mkdirSync(dir, { recursive: true });
  // Nunca se pisa una imagen anterior (un backend que repite ids de llamada).
  let file = `${stem}.${EXT[mime]}`;
  for (let i = 2; existsSync(join(dir, file)); i++) file = `${stem}-v${i}.${EXT[mime]}`;
  const path = join(dir, file);
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    writeFileSync(tmp, bytes);
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  return file;
}

export function createGenerateImageTool(): ToolDefinition {
  return {
    name: GENERATE_IMAGE_TOOL,
    description:
      'Generate images from a text description with the configured image model and save them ' +
      `to ${OUTPUTS_DIR}/, where the user sees them in the chat. Write the prompt yourself from ` +
      "the user's request: a detailed English description (subject, composition, style, lighting, " +
      'colours, mood). Read the stratum-images skill before your first call in a conversation. ' +
      'Each call costs time and money: do not call it again for the same request unless the user ' +
      'asks for changes.',
    schema,
    destructive: false,
    timeout: 300_000,

    async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
      const args = schema.parse(params);
      const endpoint = resolveImageEndpoint(ctx.config);
      if (!endpoint) {
        return fail(
          'Image generation is not configured: imageGeneration.provider must name a provider ' +
            'in the global configuration.',
          false,
        );
      }
      const img = ctx.config.imageGeneration!;
      const size = args.size ?? img.size;
      const n = args.n ?? 1;

      const timeout = AbortSignal.timeout(img.timeoutMs);
      const signal = AbortSignal.any([ctx.signal, timeout]);
      let body: { data?: Array<{ b64_json?: unknown; url?: unknown; revised_prompt?: unknown }> };
      try {
        const res = await fetch(`${endpoint.baseUrl}/images/generations`, {
          method: 'POST',
          signal,
          headers: {
            'Content-Type': 'application/json',
            ...(endpoint.apiKey ? { Authorization: `Bearer ${endpoint.apiKey}` } : {}),
          },
          body: JSON.stringify({
            model: endpoint.model,
            prompt: args.prompt,
            n,
            size,
            response_format: 'b64_json',
          }),
        });
        if (!res.ok) {
          const text = redactText((await res.text().catch(() => '')).slice(0, 500), ctx.config);
          return fail(`Image generation failed: HTTP ${res.status}${text ? ` — ${text}` : ''}`);
        }
        body = (await res.json()) as typeof body;
      } catch (err) {
        if (ctx.signal.aborted) throw err;
        const reason = timeout.aborted
          ? `no answer in ${Math.round(img.timeoutMs / 1000)} s`
          : redactText(err instanceof Error ? err.message : String(err), ctx.config);
        return fail(`Image generation failed: ${reason}`);
      }

      const items = Array.isArray(body.data) ? body.data.slice(0, MAX_IMAGES) : [];
      if (items.length === 0)
        return fail('Image generation failed: the provider returned no image');

      const stem = imageFileStem(args.name, ctx.callId, Date.now());
      const dir = join(ctx.workspace?.root ?? ctx.cwd, OUTPUTS_DIR);
      const saved: string[] = [];
      const problems: string[] = [];
      for (const [i, item] of items.entries()) {
        try {
          const bytes = await readImage(item, signal);
          const file = saveImage(dir, items.length > 1 ? `${stem}-${i + 1}` : stem, bytes);
          saved.push(`${OUTPUTS_DIR}/${file}`);
        } catch (err) {
          if (ctx.signal.aborted) throw err;
          problems.push(`image ${i + 1}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (saved.length === 0) return fail(`Image generation failed: ${problems.join('; ')}`);

      const revised = items
        .map((item) => (typeof item.revised_prompt === 'string' ? item.revised_prompt : ''))
        .find((p) => p.length > 0);
      const lines = [
        ...saved,
        '',
        `Generated ${saved.length} image(s) with ${endpoint.model} at ${size}. The user already ` +
          'sees them in the chat: do not repeat the paths or embed them in markdown.',
        ...(problems.length > 0 ? [`Not saved: ${problems.join('; ')}`] : []),
        ...(revised ? [`Prompt as revised by the model: ${revised}`] : []),
      ];
      return { ok: true, output: lines.join('\n') };
    },
  };
}
