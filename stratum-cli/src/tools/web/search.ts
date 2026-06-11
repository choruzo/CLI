import { z } from 'zod';
import type { ToolDefinition, ToolContext, ToolResult } from '../../agent/types.js';

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

// ---------------------------------------------------------------------------
// Backends
// ---------------------------------------------------------------------------

const DDG_ENDPOINT = 'https://html.duckduckgo.com/html/';
const TAVILY_ENDPOINT = 'https://api.tavily.com/search';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, '')).trim();
}

/** Resuelve el redirect `/l/?uddg=<url-encoded>` de DuckDuckGo a la URL real. */
function resolveDdgUrl(href: string): string | null {
  try {
    const normalized = href.startsWith('//') ? 'https:' + href : href;
    const url = new URL(normalized, 'https://duckduckgo.com');
    const uddg = url.searchParams.get('uddg');
    if (uddg) return uddg;
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.toString();
    return null;
  } catch {
    return null;
  }
}

/** Parsea el HTML de html.duckduckgo.com a resultados estructurados. Exportado para tests. */
export function parseDuckDuckGoHtml(html: string, maxResults: number): SearchResult[] {
  const results: SearchResult[] = [];
  // Cada resultado: <a ... class="result__a" href="...">Título</a>
  const linkRe = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippetRe =
    /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>|<td[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/td>/g;

  const links: { url: string; title: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(html)) !== null) {
    const url = resolveDdgUrl(m[1]!);
    if (!url) continue;
    // Excluir anuncios (y.js) y resultados internos de DDG
    if (url.includes('duckduckgo.com/y.js')) continue;
    links.push({ url, title: stripTags(m[2]!) });
  }

  const snippets: string[] = [];
  while ((m = snippetRe.exec(html)) !== null) {
    snippets.push(stripTags(m[1] ?? m[2] ?? ''));
  }

  for (let i = 0; i < links.length && results.length < maxResults; i++) {
    results.push({
      title: links[i]!.title,
      url: links[i]!.url,
      snippet: snippets[i] ?? '',
    });
  }
  return results;
}

async function searchDuckDuckGo(
  query: string,
  maxResults: number,
  signal: AbortSignal,
): Promise<SearchResult[]> {
  const body = new URLSearchParams({ q: query, kl: 'wt-wt' });
  const res = await fetch(DDG_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': USER_AGENT,
    },
    body: body.toString(),
    signal,
  });
  if (!res.ok) throw new Error(`DuckDuckGo returned HTTP ${res.status}`);
  const html = await res.text();
  return parseDuckDuckGoHtml(html, maxResults);
}

interface TavilyResponse {
  results?: { title?: string; url?: string; content?: string }[];
}

async function searchTavily(
  query: string,
  apiKey: string,
  maxResults: number,
  signal: AbortSignal,
): Promise<SearchResult[]> {
  const res = await fetch(TAVILY_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      max_results: maxResults,
      search_depth: 'basic',
    }),
    signal,
  });
  if (!res.ok) throw new Error(`Tavily returned HTTP ${res.status}`);
  const data = (await res.json()) as TavilyResponse;
  return (data.results ?? [])
    .filter((r) => typeof r.url === 'string' && r.url.length > 0)
    .map((r) => ({
      title: r.title ?? r.url!,
      url: r.url!,
      snippet: (r.content ?? '').slice(0, 300),
    }));
}

// ---------------------------------------------------------------------------
// Merge + dedupe + re-rank (Reciprocal Rank Fusion)
// ---------------------------------------------------------------------------

/** Normaliza una URL para deduplicación: host lowercase, sin trailing slash ni params de tracking. */
export function normalizeUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.hash = '';
    const params = url.searchParams;
    for (const key of [...params.keys()]) {
      if (/^(utm_|fbclid|gclid|ref_|mc_)/i.test(key)) params.delete(key);
    }
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, '');
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, '');
    let s = url.toString();
    if (s.endsWith('/')) s = s.slice(0, -1);
    return s;
  } catch {
    return raw;
  }
}

/**
 * Fusiona listas de resultados de varios motores con Reciprocal Rank Fusion:
 * score(url) = Σ 1/(k + rank). Las URLs presentes en varios motores suman
 * score de cada uno y suben de forma natural. Exportado para tests.
 */
export function mergeResults(lists: SearchResult[][], topN: number, k = 60): SearchResult[] {
  const scored = new Map<string, { result: SearchResult; score: number }>();

  for (const list of lists) {
    for (let rank = 0; rank < list.length; rank++) {
      const r = list[rank]!;
      const key = normalizeUrl(r.url);
      const rrf = 1 / (k + rank + 1);
      const existing = scored.get(key);
      if (existing) {
        existing.score += rrf;
        // Conservar el snippet más informativo
        if (r.snippet.length > existing.result.snippet.length) {
          existing.result = { ...existing.result, snippet: r.snippet };
        }
      } else {
        scored.set(key, { result: r, score: rrf });
      }
    }
  }

  return [...scored.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, topN)
    .map((e) => e.result);
}

function formatResults(results: SearchResult[]): string {
  return results
    .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ''}`)
    .join('\n\n');
}

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

const schema = z.object({
  query: z.string().min(1).describe('Search query'),
  max_results: z
    .number()
    .int()
    .positive()
    .max(20)
    .optional()
    .describe('Maximum number of results to return (default 10)'),
});

export const webSearchTool: ToolDefinition = {
  name: 'web_search',
  description:
    'Search the web. Queries DuckDuckGo (and Tavily when an API key is configured), merges and ' +
    'de-duplicates the results, and returns the top URLs with title and snippet. ' +
    'Use web_fetch afterwards to read the full content of a promising URL.',
  schema,
  destructive: false,
  timeout: 30000,

  async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
    const { query, max_results } = schema.parse(params);
    const cfg = ctx.config.tools.webSearch;
    const topN = max_results ?? cfg.maxResults;

    const backend = cfg.backend;
    if (backend === 'brave' || backend === 'serpapi') {
      return {
        ok: false,
        error: `web_search backend "${backend}" is not implemented yet. Use "meta", "duckduckgo" or "tavily" in .stratumrc.json (tools.webSearch.backend).`,
        recoverable: false,
      };
    }

    const tavilyKey = cfg.tavilyApiKey || cfg.apiKey || process.env.TAVILY_API_KEY || '';

    const useDdg = backend === 'meta' || backend === 'duckduckgo';
    const useTavily = (backend === 'meta' && tavilyKey !== '') || backend === 'tavily';

    if (backend === 'tavily' && tavilyKey === '') {
      return {
        ok: false,
        error:
          'web_search backend "tavily" requires an API key (tools.webSearch.tavilyApiKey or TAVILY_API_KEY).',
        recoverable: false,
      };
    }

    const tasks: Promise<SearchResult[]>[] = [];
    const sources: string[] = [];
    if (useDdg) {
      tasks.push(searchDuckDuckGo(query, 30, ctx.signal));
      sources.push('duckduckgo');
    }
    if (useTavily) {
      tasks.push(searchTavily(query, tavilyKey, 10, ctx.signal));
      sources.push('tavily');
    }

    const settled = await Promise.allSettled(tasks);
    const lists: SearchResult[][] = [];
    const failures: string[] = [];
    settled.forEach((s, i) => {
      if (s.status === 'fulfilled') lists.push(s.value);
      else failures.push(`${sources[i]}: ${String((s as PromiseRejectedResult).reason)}`);
    });

    if (lists.length === 0) {
      return {
        ok: false,
        error: `All search backends failed — ${failures.join(' | ')}`,
        recoverable: true,
      };
    }

    const merged = mergeResults(lists, topN);
    if (merged.length === 0) {
      return { ok: true, output: `(no results for "${query}")` };
    }

    const failureNote =
      failures.length > 0 ? `\n\n[note] Some backends failed: ${failures.join(' | ')}` : '';
    return { ok: true, output: formatResults(merged) + failureNote };
  },
};
