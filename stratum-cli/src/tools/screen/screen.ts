/**
 * M15 — computer use en la caja (PRD de Stratum Dot §23.4): las tools
 * `screen_*` sobre el escritorio virtual de `container:<caja>` (Xvfb en `:99`,
 * `xdotool` e ImageMagick, de la imagen de Stratum).
 *
 * Cada acción se ejecuta con el backend de la caja (`containerBackend`: mismo
 * contrato que `exec`, nunca cae a `local`) y devuelve una captura nueva en el
 * mismo `<runtime> exec`. La captura viaja como `ToolResult.image`, fuera del
 * texto: el loop decide si llega al modelo. El texto solo lleva metadatos.
 *
 * Nada del modelo entra en la línea de órdenes sin validar: las coordenadas
 * son enteros que calcula Stratum, las teclas pasan por una gramática cerrada
 * y el texto a escribir va por stdin (`xdotool type --file -`).
 *
 * Sin visión declarada (`ToolContext.vision`) se vetan en `preflight`: el loop
 * ya no las ofrece, esto es la red por si el modelo las inventa.
 */
import { z } from 'zod';
import type { ToolContext, ToolDefinition, ToolImage, ToolResult } from '../../agent/types.js';
import type { ModelVision } from '../../config/schema.js';
import { ExecConnectError, isHandedOver } from '../exec/backend.js';
import { containerBackend } from '../exec/backends/container.js';
import type { ExecutionTarget } from '../exec/target.js';
import { coordinatesHint, pngImage, toScreenPoint, type ScreenGeometry } from './geometry.js';

/** Plazo de cada orden en la caja. Una captura tarda bastante menos. */
const COMMAND_TIMEOUT_MS = 30_000;
/** Tope de salida: un PNG de 1280×800 en base64 ronda el medio mega. */
const CAPTURE_MAX_BYTES = 16 * 1024 * 1024;
/** Lo que se espera tras una acción antes de capturar: que la página reaccione. */
const SETTLE_SECONDS = 0.8;
const MAX_TYPE_CHARS = 4000;
const MAX_WAIT_SECONDS = 30;

const ENV = 'export DISPLAY="${DISPLAY:-:99}"; ';
const CAPTURE = 'import -window root png:- | base64 -w0';

/** Una o varias combinaciones de keysyms de X separadas por espacios: `ctrl+l`, `Return`, `ctrl+a BackSpace`. */
const KEYS_RE = /^[A-Za-z0-9_]+(\+[A-Za-z0-9_]+)*( [A-Za-z0-9_]+(\+[A-Za-z0-9_]+)*)*$/;

const BUTTONS = { left: 1, middle: 2, right: 3 } as const;
const SCROLL_BUTTONS = { up: 4, down: 5, left: 6, right: 7 } as const;

const coordinate = (axis: 'x' | 'y') =>
  z
    .number()
    .describe(
      `${axis} of the point, in the coordinate convention stated with the latest screenshot`,
    );

const screenshotSchema = z.object({});
const clickSchema = z.object({
  x: coordinate('x'),
  y: coordinate('y'),
  button: z.enum(['left', 'middle', 'right']).optional().describe('Mouse button (default left)'),
  double: z.boolean().optional().describe('Double click'),
});
const typeSchema = z.object({
  text: z
    .string()
    .min(1)
    .max(MAX_TYPE_CHARS)
    .describe('Text to type at the keyboard focus. A newline presses Enter.'),
});
const keySchema = z.object({
  keys: z
    .string()
    .max(200)
    .describe(
      'X keysyms to press, combined with "+" and separated by spaces: "Return", "Tab", "Escape", ' +
        '"ctrl+l", "ctrl+a BackSpace", "Page_Down", "alt+Left".',
    ),
});
const scrollSchema = z.object({
  direction: z.enum(['up', 'down', 'left', 'right']),
  amount: z
    .number()
    .int()
    .min(1)
    .max(25)
    .optional()
    .describe('Wheel clicks (default 5; about 3 lines each)'),
  x: coordinate('x').optional(),
  y: coordinate('y').optional(),
});
const waitSchema = z.object({
  seconds: z
    .number()
    .min(0.1)
    .max(MAX_WAIT_SECONDS)
    .describe('How long to wait before the screenshot (a page loading, an animation)'),
});

function recoverable(error: string): ToolResult {
  return { ok: false, error, recoverable: true };
}

/** Lo que el modelo lee de cada captura; la imagen va aparte. */
function describeShot(image: ToolImage, vision: ModelVision): string {
  return (
    `Screenshot ${image.sha256.slice(0, 12)} (${image.width}×${image.height}). ` +
    coordinatesHint(vision, image)
  );
}

function noVision(): ToolResult {
  return {
    ok: false,
    error:
      'The current model is not declared with vision, so it cannot use the screen. ' +
      'Work with exec in the box instead.',
    recoverable: true,
    countsAsFailure: false,
  };
}

/**
 * Las seis tools sobre la pantalla de `target` (la caja). Comparten la última
 * geometría vista: un modelo `norm1000` necesita el tamaño de la pantalla
 * para convertir su punto, y así no se pregunta en cada clic.
 */
export function createScreenTools(
  target: ExecutionTarget & { kind: 'container' },
): ToolDefinition[] {
  let geometry: ScreenGeometry | undefined;

  type BoxRun = { ok: true; stdout: string } | { ok: false; result: ToolResult };

  async function runInBox(ctx: ToolContext, command: string, stdin?: string): Promise<BoxRun> {
    let outcome;
    try {
      outcome = await containerBackend.run(
        target,
        {
          command: ENV + command,
          ...(stdin !== undefined ? { stdin } : {}),
          timeoutMs: COMMAND_TIMEOUT_MS,
          maxBytes: CAPTURE_MAX_BYTES,
          signal: ctx.signal,
        },
        ctx,
      );
    } catch (err) {
      if (err instanceof ExecConnectError) return { ok: false, result: recoverable(err.message) };
      return {
        ok: false,
        result: recoverable(`Could not reach the box screen: ${(err as Error).message}`),
      };
    }
    // Solo `local` pasa un comando a job; la caja nunca.
    if (isHandedOver(outcome)) {
      return { ok: false, result: recoverable('The box screen command did not finish.') };
    }
    if (outcome.status === 'cancelled') {
      return {
        ok: false,
        result: { ok: false, error: 'Cancelled by the user.', recoverable: false },
      };
    }
    if (outcome.status === 'timeout') {
      return {
        ok: false,
        result: recoverable(`The box screen did not answer within ${COMMAND_TIMEOUT_MS / 1000} s.`),
      };
    }
    if (outcome.status === 'truncated') {
      return { ok: false, result: recoverable('The screenshot was larger than the limit.') };
    }
    if (outcome.exitCode !== 0) {
      const detail =
        outcome.stderr.trim().slice(0, 500) || `exit code ${outcome.exitCode ?? 'unknown'}`;
      return {
        ok: false,
        result: recoverable(
          `The box screen failed: ${detail}. Its virtual desktop may not be running ` +
            '(the box image needs Xvfb on :99, xdotool and ImageMagick).',
        ),
      };
    }
    return { ok: true, stdout: outcome.stdout };
  }

  async function screenGeometry(ctx: ToolContext): Promise<ScreenGeometry | ToolResult> {
    if (geometry) return geometry;
    const r = await runInBox(ctx, 'xdotool getdisplaygeometry');
    if (!r.ok) return r.result;
    const m = /^(\d+)\s+(\d+)/.exec(r.stdout.trim());
    if (!m) return recoverable('Could not read the size of the box screen.');
    geometry = { width: Number(m[1]), height: Number(m[2]) };
    return geometry;
  }

  /** Ejecuta `action` (o nada), espera `settle` y captura en el mismo `exec`. */
  async function actAndCapture(
    ctx: ToolContext,
    vision: ModelVision,
    summary: string,
    action: string | null,
    settle: number,
    stdin?: string,
  ): Promise<ToolResult> {
    const steps = [
      ...(action ? [action] : []),
      ...(settle > 0 ? [`sleep ${settle}`] : []),
      CAPTURE,
    ];
    const r = await runInBox(ctx, steps.join(' && '), stdin);
    if (!r.ok) return r.result;
    let image: ToolImage;
    try {
      image = pngImage(r.stdout);
    } catch (err) {
      return recoverable(`Could not read the screenshot: ${(err as Error).message}.`);
    }
    geometry = { width: image.width, height: image.height };
    const text = summary
      ? `${summary}\n${describeShot(image, vision)}`
      : describeShot(image, vision);
    return { ok: true, output: text, image };
  }

  /** El punto del modelo como píxel, o el error que explica por qué no. */
  async function point(
    ctx: ToolContext,
    vision: ModelVision,
    x: number,
    y: number,
  ): Promise<{ x: number; y: number } | ToolResult> {
    const screen = await screenGeometry(ctx);
    if ('ok' in screen) return screen;
    const p = toScreenPoint(x, y, vision, screen);
    return p.ok ? { x: p.x, y: p.y } : recoverable(p.error);
  }

  const visionGate = (_params: unknown, ctx: ToolContext): ToolResult | null =>
    ctx.vision ? null : noVision();

  const at = (
    requested: { x: number; y: number },
    px: { x: number; y: number },
    vision: ModelVision,
  ): string =>
    vision.coordinates === 'pixels'
      ? `(${px.x}, ${px.y})`
      : `(${requested.x}, ${requested.y}) → pixel (${px.x}, ${px.y})`;

  const base = {
    destructive: false,
    timeout: COMMAND_TIMEOUT_MS * 2 + 10_000,
    // Cancelar lo resuelve el backend de la caja (mata el grupo dentro).
    structuredCancellation: true,
    preflight: visionGate,
  } as const;

  return [
    {
      ...base,
      name: 'screen_screenshot',
      description:
        "Take a screenshot of your box's virtual screen (the desktop where you run Chromium). " +
        'The image is shown to you after the call. Every other screen_* tool already returns a ' +
        'fresh screenshot: use this one only to look without acting.',
      schema: screenshotSchema,
      async execute(_params, ctx) {
        if (!ctx.vision) return noVision();
        return actAndCapture(ctx, ctx.vision, '', null, 0);
      },
    },
    {
      ...base,
      name: 'screen_click',
      description:
        "Move the mouse to a point of your box's screen and click there. Returns a new screenshot.",
      schema: clickSchema,
      async execute(params, ctx) {
        if (!ctx.vision) return noVision();
        const input = clickSchema.parse(params);
        const p = await point(ctx, ctx.vision, input.x, input.y);
        if ('ok' in p) return p;
        const button = BUTTONS[input.button ?? 'left'];
        const repeat = input.double ? ' --repeat 2 --delay 120' : '';
        return actAndCapture(
          ctx,
          ctx.vision,
          `${input.double ? 'Double-clicked' : 'Clicked'} ${input.button ?? 'left'} at ${at(input, p, ctx.vision)}.`,
          `xdotool mousemove --sync ${p.x} ${p.y} click${repeat} ${button}`,
          SETTLE_SECONDS,
        );
      },
    },
    {
      ...base,
      name: 'screen_type',
      description:
        "Type text with the keyboard of your box's screen, where the focus is (click a field first). " +
        'Returns a new screenshot.',
      schema: typeSchema,
      async execute(params, ctx) {
        if (!ctx.vision) return noVision();
        const input = typeSchema.parse(params);
        return actAndCapture(
          ctx,
          ctx.vision,
          `Typed ${input.text.length} characters.`,
          'xdotool type --clearmodifiers --delay 12 --file -',
          SETTLE_SECONDS,
          input.text,
        );
      },
    },
    {
      ...base,
      name: 'screen_key',
      description:
        "Press keys or key combinations on your box's screen (Enter, Tab, shortcuts). Returns a new screenshot.",
      schema: keySchema,
      async execute(params, ctx) {
        if (!ctx.vision) return noVision();
        const input = keySchema.parse(params);
        const keys = input.keys.trim();
        if (!KEYS_RE.test(keys)) {
          return recoverable(
            `"${input.keys}" is not a key sequence: use X keysyms joined with "+" and separated by spaces ` +
              '(e.g. "Return", "ctrl+l", "ctrl+a BackSpace").',
          );
        }
        return actAndCapture(
          ctx,
          ctx.vision,
          `Pressed ${keys}.`,
          `xdotool key --clearmodifiers ${keys}`,
          SETTLE_SECONDS,
        );
      },
    },
    {
      ...base,
      name: 'screen_scroll',
      description:
        "Scroll with the mouse wheel on your box's screen, over a point if given (else where the mouse is). " +
        'Returns a new screenshot.',
      schema: scrollSchema,
      async execute(params, ctx) {
        if (!ctx.vision) return noVision();
        const input = scrollSchema.parse(params);
        if ((input.x === undefined) !== (input.y === undefined)) {
          return recoverable('Give both x and y, or neither.');
        }
        let move = '';
        let where = '';
        if (input.x !== undefined && input.y !== undefined) {
          const p = await point(ctx, ctx.vision, input.x, input.y);
          if ('ok' in p) return p;
          move = `xdotool mousemove --sync ${p.x} ${p.y} && `;
          where = ` at ${at({ x: input.x, y: input.y }, p, ctx.vision)}`;
        }
        const amount = input.amount ?? 5;
        return actAndCapture(
          ctx,
          ctx.vision,
          `Scrolled ${input.direction} ${amount}${where}.`,
          `${move}xdotool click --repeat ${amount} --delay 40 ${SCROLL_BUTTONS[input.direction]}`,
          SETTLE_SECONDS,
        );
      },
    },
    {
      ...base,
      name: 'screen_wait',
      description:
        "Wait a moment (a page loading, an animation) and take a screenshot of your box's screen.",
      schema: waitSchema,
      async execute(params, ctx) {
        if (!ctx.vision) return noVision();
        const input = waitSchema.parse(params);
        const seconds = Math.round(input.seconds * 10) / 10;
        return actAndCapture(ctx, ctx.vision, `Waited ${seconds} s.`, null, seconds);
      },
    },
  ];
}
