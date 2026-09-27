import { z } from 'zod';
import type { ToolDefinition, ToolContext, ToolResult } from '../../agent/types.js';
import { htmlToText, extractTitle } from './html-to-text.js';
import { safeFetch, BlockedHostError, type SafeFetchResponse } from './safe-fetch.js';

const MAX_BODY_BYTES = 5 * 1024 * 1024; // 5 MB

const schema = z.object({
  url: z.string().url().describe('URL to fetch (http or https)'),
  raw: z
    .boolean()
    .optional()
    .describe('Return the raw body without HTML-to-text extraction (default: false)'),
});

export const webFetchTool: ToolDefinition = {
  name: 'web_fetch',
  description:
    'Fetch a URL and return its content as clean readable text. HTML pages are converted to ' +
    'markdown-like text (scripts, styles and navigation removed). Sends Accept: text/markdown ' +
    'so servers that support it can return markdown directly. Non-HTML content (JSON, plain ' +
    'text, markdown) is returned as-is. Use raw: true to skip extraction. Private, loopback and ' +
    'link-local addresses (and redirects to them) are refused unless the host is listed in ' +
    'tools.webFetch.allowHosts; do not retry a refused URL.',
  schema,
  destructive: false,
  timeout: 45000,

  async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
    const { url, raw } = schema.parse(params);

    let res: SafeFetchResponse;
    try {
      res = await safeFetch(url, {
        signal: ctx.signal,
        maxBytes: MAX_BODY_BYTES,
        allowHosts: ctx.config.tools.webFetch.allowHosts,
        headers: {
          // Preferencia por markdown si el servidor lo soporta (spec §4.3),
          // con fallback estándar a HTML/texto.
          Accept: 'text/markdown, text/html;q=0.9, text/plain;q=0.8, */*;q=0.5',
          'User-Agent': 'stratum-cli (+https://github.com/stratum-cli) web_fetch',
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Un host bloqueado no es un fallo de la tool: reintentar no lo cambia y
      // no debe acercarla a deshabilitarse.
      if (err instanceof BlockedHostError) {
        return {
          ok: false,
          error: `Fetch refused for ${url}: ${msg}`,
          recoverable: true,
          countsAsFailure: false,
        };
      }
      return { ok: false, error: `Fetch failed for ${url}: ${msg}`, recoverable: true };
    }

    if (res.status < 200 || res.status >= 300) {
      return {
        ok: false,
        error: `HTTP ${res.status} ${res.statusText} fetching ${url}`,
        recoverable: true,
      };
    }

    const contentType = String(res.headers['content-type'] ?? '').toLowerCase();
    const body = res.body;

    if (raw) {
      return { ok: true, output: body };
    }

    const isHtml =
      contentType.includes('text/html') ||
      contentType.includes('application/xhtml') ||
      (contentType === '' && /<html[\s>]/i.test(body.slice(0, 2000)));

    if (!isHtml) {
      // markdown / JSON / texto plano — devolver tal cual
      return { ok: true, output: body };
    }

    const title = extractTitle(body);
    const text = htmlToText(body);
    if (!text) {
      return {
        ok: true,
        output: `(page at ${url} produced no extractable text — it may be JavaScript-rendered)`,
      };
    }

    const header = title ? `# ${title}\nURL: ${res.url}\n\n` : `URL: ${res.url}\n\n`;
    return { ok: true, output: header + text };
  },
};
