import { z } from 'zod';
import type { ToolDefinition, ToolContext, ToolResult } from '../../agent/types.js';
import { htmlToText, extractTitle } from './html-to-text.js';

const MAX_BODY_BYTES = 5 * 1024 * 1024; // 5 MB

const schema = z.object({
  url: z.string().url().describe('URL to fetch (http or https)'),
  raw: z
    .boolean()
    .optional()
    .describe('Return the raw body without HTML-to-text extraction (default: false)'),
});

async function readBodyLimited(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return await res.text();

  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    chunks.push(value);
    if (total > MAX_BODY_BYTES) {
      void reader.cancel();
      break;
    }
  }
  const buf = new Uint8Array(Math.min(total, MAX_BODY_BYTES));
  let offset = 0;
  for (const chunk of chunks) {
    const slice = chunk.subarray(0, Math.min(chunk.byteLength, buf.byteLength - offset));
    buf.set(slice, offset);
    offset += slice.byteLength;
    if (offset >= buf.byteLength) break;
  }
  return new TextDecoder('utf-8').decode(buf);
}

export const webFetchTool: ToolDefinition = {
  name: 'web_fetch',
  description:
    'Fetch a URL and return its content as clean readable text. HTML pages are converted to ' +
    'markdown-like text (scripts, styles and navigation removed). Sends Accept: text/markdown ' +
    'so servers that support it can return markdown directly. Non-HTML content (JSON, plain ' +
    'text, markdown) is returned as-is. Use raw: true to skip extraction.',
  schema,
  destructive: false,
  timeout: 45000,

  async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
    const { url, raw } = schema.parse(params);

    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return {
        ok: false,
        error: `Unsupported protocol "${parsed.protocol}" — only http/https.`,
        recoverable: true,
      };
    }

    let res: Response;
    try {
      res = await fetch(url, {
        redirect: 'follow',
        signal: ctx.signal,
        headers: {
          // Preferencia por markdown si el servidor lo soporta (spec §4.3),
          // con fallback estándar a HTML/texto.
          Accept: 'text/markdown, text/html;q=0.9, text/plain;q=0.8, */*;q=0.5',
          'User-Agent': 'stratum-cli (+https://github.com/stratum-cli) web_fetch',
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `Fetch failed for ${url}: ${msg}`, recoverable: true };
    }

    if (!res.ok) {
      return {
        ok: false,
        error: `HTTP ${res.status} ${res.statusText} fetching ${url}`,
        recoverable: true,
      };
    }

    const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
    let body: string;
    try {
      body = await readBodyLimited(res);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `Failed reading body of ${url}: ${msg}`, recoverable: true };
    }

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

    const header = title ? `# ${title}\nURL: ${res.url || url}\n\n` : `URL: ${res.url || url}\n\n`;
    return { ok: true, output: header + text };
  },
};
