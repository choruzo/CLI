/**
 * Las tools del navegador del agente: abrir la app que acaba de tocar en
 * `localhost`, leer la página, su consola y sus errores, pulsar, escribir y,
 * con un modelo con visión, capturar. Sin estado propio: el navegador es el de
 * la sesión (`ToolContext.browser`, un `BrowserManager`); sin él, todas se
 * vetan en `preflight`.
 *
 * Alcance (`browser/policy.ts`): lo local es libre; otra URL pide la
 * confirmación normal del dispatcher (`isDestructive`) y, aprobada, su origen
 * queda aprobado para la sesión; lo vetado (`blocked`) no se abre nunca, ni
 * con aprobación. La misma política se aplica en la red, así que un clic o una
 * redirección no se la saltan.
 *
 * `browser_screenshot` sigue las reglas de M15: solo con visión declarada, y la
 * imagen viaja como `ToolResult.image`, nunca en el texto.
 */
import { z } from 'zod';
import type { ToolContext, ToolDefinition, ToolImage, ToolResult } from '../../agent/types.js';
import {
  BrowserActionError,
  BrowserUnavailableError,
  BROWSER_LIMITS,
  type BrowserManager,
  type SnapshotResult,
} from '../../browser/manager.js';
import { pngImage } from '../screen/geometry.js';
import { stringParam } from '../fs/confine.js';
import { BROWSER_NAVIGATE_TOOL, BROWSER_SCREENSHOT_TOOL } from './names.js';

/** URL de `browser_navigate`: entera en la solicitud de confirmación (`INPUT_CHARS` del publicador). */
export const BROWSER_URL_MAX_CHARS = 1900;
const MAX_TYPE_CHARS = 4000;
const TOOL_TIMEOUT_MS = 60_000;

const navigateSchema = z.object({
  url: z
    .string()
    .min(1)
    .max(BROWSER_URL_MAX_CHARS)
    .describe(
      'URL to open: http(s)://localhost:<port>/…, 127.0.0.1, a file inside the session folder (file:///…), ' +
        'or another site (that one asks the user first).',
    ),
});
const emptySchema = z.object({});
const refSchema = z
  .string()
  .max(16)
  .describe('Element reference from the latest browser_snapshot, like "e12"');
const clickSchema = z.object({ ref: refSchema });
const typeSchema = z.object({
  ref: refSchema,
  text: z
    .string()
    .max(MAX_TYPE_CHARS)
    .describe('Text to type into the field; it replaces what the field had.'),
  submit: z.boolean().optional().describe('Press Enter after typing (submit the form)'),
});
const pressSchema = z.object({
  keys: z
    .string()
    .max(200)
    .describe(
      'Keys to press in the page, combined with "+" and separated by spaces: "Enter", "Tab", "Escape", ' +
        '"ctrl+a Backspace", "shift+Tab", "ArrowDown", "PageDown".',
    ),
});
const evalSchema = z.object({
  expression: z
    .string()
    .min(1)
    .max(20_000)
    .describe(
      'JavaScript expression evaluated in the page (an awaited promise is fine). Its value is returned as JSON.',
    ),
});

function recoverable(error: string): ToolResult {
  return { ok: false, error, recoverable: true };
}

function noBrowser(): ToolResult {
  return {
    ok: false,
    error: 'The browser is not available in this session.',
    recoverable: true,
    countsAsFailure: false,
  };
}

function failure(err: unknown): ToolResult {
  if (err instanceof BrowserUnavailableError) {
    return { ok: false, error: err.message, recoverable: true, countsAsFailure: false };
  }
  if (err instanceof BrowserActionError) return recoverable(err.message);
  return recoverable(`The browser failed: ${err instanceof Error ? err.message : String(err)}`);
}

/** Navegaciones que la política paró (un clic, una redirección), para que el modelo lo sepa. */
function blockedNote(browser: BrowserManager): string {
  const blocked = browser.takeBlockedNavigations();
  return blocked.length > 0 ? `${blocked.map((b) => `Note: ${b}.`).join('\n')}\n` : '';
}

function errorsNote(browser: BrowserManager): string {
  const errors = browser.pendingErrors();
  return errors > 0
    ? `Console: ${errors} error${errors === 1 ? '' : 's'} so far (read them with browser_console).\n`
    : '';
}

export function formatSnapshot(snap: SnapshotResult): string {
  const body = snap.text.trim() || '(the page has no visible text)';
  return (
    `Title: ${snap.title || '(none)'}\nURL: ${snap.url}\n\n${body}` +
    (snap.truncated
      ? `\n[snapshot truncated at about ${BROWSER_LIMITS.snapshotChars} characters; scroll with browser_press or narrow down with browser_eval]`
      : '')
  );
}

/** El navegador de la sesión, o el veto que explica que no hay. */
function browserOf(ctx: ToolContext): BrowserManager | null {
  return ctx.browser ?? null;
}

const needsBrowser = (_params: unknown, ctx: ToolContext): ToolResult | null =>
  browserOf(ctx) ? null : noBrowser();

const base = {
  destructive: false,
  // Una sola pestaña: dos acciones a la vez se pisarían.
  serialized: true,
  timeout: TOOL_TIMEOUT_MS,
  preflight: needsBrowser,
} as const;

async function afterAction(
  browser: BrowserManager,
  summary: string,
  run: () => Promise<SnapshotResult>,
): Promise<ToolResult> {
  try {
    const snap = await run();
    return {
      ok: true,
      output: `${summary}\n${blockedNote(browser)}${errorsNote(browser)}\n${formatSnapshot(snap)}`,
    };
  } catch (err) {
    return failure(err);
  }
}

export function createBrowserTools(): ToolDefinition[] {
  return [
    {
      ...base,
      name: BROWSER_NAVIGATE_TOOL,
      description:
        'Open a URL in your headless browser (one tab) and wait for it to load; returns the final URL, title, ' +
        'HTTP status, console error count and a text snapshot of the page. Use it to check your work in the ' +
        'real app: a dev server on localhost, a built page in the project. Local URLs open directly; any other ' +
        'site asks the user for approval first.',
      schema: navigateSchema,
      preflight(params, ctx) {
        const browser = browserOf(ctx);
        if (!browser) return noBrowser();
        const url = stringParam(params, 'url') ?? '';
        const verdict = browser.inspect(url);
        if (verdict.class !== 'blocked') return null;
        return {
          ok: false,
          error:
            `The browser will not open "${url.slice(0, 200)}": ${verdict.reason ?? 'blocked'}. ` +
            'Only http(s) URLs and files inside the session folder open, and no approval can lift this.',
          recoverable: true,
          countsAsFailure: false,
        };
      },
      // Lo externo pasa por la confirmación del dispatcher, con la URL entera.
      isDestructive(params, ctx) {
        const browser = browserOf(ctx);
        if (!browser) return false;
        return browser.inspect(stringParam(params, 'url') ?? '').class === 'external';
      },
      async execute(params, ctx) {
        const browser = browserOf(ctx);
        if (!browser) return noBrowser();
        const input = navigateSchema.parse(params);
        const verdict = browser.inspect(input.url);
        if (verdict.class === 'blocked')
          return recoverable(`This URL cannot be opened: ${verdict.reason ?? 'blocked'}.`);
        // Llegar aquí con un origen externo es que la confirmación lo aprobó.
        if (verdict.class === 'external' && verdict.origin) browser.approveOrigin(verdict.origin);
        try {
          const info = await browser.navigate(input.url, ctx.signal);
          const head =
            `Navigated to ${info.url}` +
            (info.title ? ` — "${info.title}"` : '') +
            (info.status !== undefined ? ` (HTTP ${info.status})` : '') +
            '.\n' +
            (info.error ? `The navigation failed: ${info.error}.\n` : '') +
            (info.timedOut
              ? 'The page did not finish loading within 20 s; this is what it shows now.\n'
              : '');
          const snap = await browser.snapshot(ctx.signal);
          return {
            ok: true,
            output: `${head}${blockedNote(browser)}${errorsNote(browser)}\n${formatSnapshot(snap)}`,
          };
        } catch (err) {
          return failure(err);
        }
      },
    },
    {
      ...base,
      name: 'browser_snapshot',
      description:
        'Read the current page of your browser as text: title, URL, headings, visible text and the elements you ' +
        'can act on, each with a reference like [e12] for browser_click and browser_type. Prefer it to a screenshot.',
      schema: emptySchema,
      async execute(_params, ctx) {
        const browser = browserOf(ctx);
        if (!browser) return noBrowser();
        try {
          const snap = await browser.snapshot(ctx.signal);
          return { ok: true, output: `${errorsNote(browser)}${formatSnapshot(snap)}` };
        } catch (err) {
          return failure(err);
        }
      },
    },
    {
      ...base,
      name: 'browser_click',
      description:
        'Click an element of the current page by its reference from the latest browser_snapshot. Returns the new snapshot.',
      schema: clickSchema,
      async execute(params, ctx) {
        const browser = browserOf(ctx);
        if (!browser) return noBrowser();
        const input = clickSchema.parse(params);
        return afterAction(browser, `Clicked [${input.ref}].`, () =>
          browser.click(input.ref, ctx.signal),
        );
      },
    },
    {
      ...base,
      name: 'browser_type',
      description:
        'Type text into a field of the current page (by its reference from the latest browser_snapshot), replacing ' +
        'its content; optionally press Enter. Returns the new snapshot.',
      schema: typeSchema,
      async execute(params, ctx) {
        const browser = browserOf(ctx);
        if (!browser) return noBrowser();
        const input = typeSchema.parse(params);
        return afterAction(
          browser,
          `Typed ${input.text.length} characters into [${input.ref}]${input.submit ? ' and pressed Enter' : ''}.`,
          () => browser.type(input.ref, input.text, input.submit === true, ctx.signal),
        );
      },
    },
    {
      ...base,
      name: 'browser_press',
      description:
        'Press keys or key combinations in the current page (where the focus is). Returns the new snapshot.',
      schema: pressSchema,
      async execute(params, ctx) {
        const browser = browserOf(ctx);
        if (!browser) return noBrowser();
        const input = pressSchema.parse(params);
        return afterAction(browser, `Pressed ${input.keys.trim()}.`, () =>
          browser.press(input.keys, ctx.signal),
        );
      },
    },
    {
      ...base,
      name: 'browser_console',
      description:
        "Read your browser's console messages, page exceptions and failed requests (URL and status) since the " +
        'last time you read them.',
      schema: emptySchema,
      async execute(_params, ctx) {
        const browser = browserOf(ctx);
        if (!browser) return noBrowser();
        const lines = browser.takeConsole();
        return {
          ok: true,
          output: lines.length > 0 ? lines.join('\n') : 'No new console messages.',
        };
      },
    },
    {
      ...base,
      name: 'browser_eval',
      description:
        'Evaluate a JavaScript expression in the current page and return its value as JSON (up to 8 KB, 10 s). ' +
        'Use it to inspect state the snapshot does not show.',
      schema: evalSchema,
      async execute(params, ctx) {
        const browser = browserOf(ctx);
        if (!browser) return noBrowser();
        const input = evalSchema.parse(params);
        try {
          const value = await browser.evaluate(input.expression, ctx.signal);
          return { ok: true, output: `${blockedNote(browser)}${value}` };
        } catch (err) {
          return failure(err);
        }
      },
    },
    {
      ...base,
      name: BROWSER_SCREENSHOT_TOOL,
      description:
        'Take a screenshot of the current page of your browser; the image is shown to you after the call. ' +
        'Use it only when the look of the page matters (layout, styles): browser_snapshot is cheaper.',
      schema: emptySchema,
      preflight(params, ctx) {
        const vetoed = needsBrowser(params, ctx);
        if (vetoed) return vetoed;
        if (ctx.vision) return null;
        return {
          ok: false,
          error:
            'The current model is not declared with vision, so it cannot see screenshots. Use browser_snapshot instead.',
          recoverable: true,
          countsAsFailure: false,
        };
      },
      async execute(_params, ctx) {
        const browser = browserOf(ctx);
        if (!browser) return noBrowser();
        if (!ctx.vision) return recoverable('The current model is not declared with vision.');
        try {
          const data = await browser.screenshotPng(ctx.signal);
          const image: ToolImage = pngImage(data);
          return {
            ok: true,
            output: `Screenshot ${image.sha256.slice(0, 12)} (${image.width}×${image.height}) of the current page.`,
            image,
          };
        } catch (err) {
          return failure(err);
        }
      },
    },
  ];
}
