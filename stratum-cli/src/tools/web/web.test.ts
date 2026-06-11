import { describe, it, expect, vi, afterEach } from 'vitest';
import { parseDuckDuckGoHtml, normalizeUrl, mergeResults, webSearchTool } from './search.js';
import type { SearchResult } from './search.js';
import { htmlToText, extractTitle, decodeHtmlEntities } from './html-to-text.js';
import { webFetchTool } from './fetch.js';
import type { ToolContext } from '../../agent/types.js';
import { StratumConfigSchema } from '../../config/schema.js';

function makeCtx(webSearch: Record<string, unknown> = {}): ToolContext {
  const config = StratumConfigSchema.parse({ tools: { webSearch } });
  return { signal: new AbortController().signal, cwd: process.cwd(), config };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// DuckDuckGo HTML parsing
// ---------------------------------------------------------------------------

const DDG_HTML = `
<div class="result">
  <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs&amp;rut=abc">Example <b>Docs</b></a>
  <a class="result__snippet" href="#">Documentation for the &quot;example&quot; project</a>
</div>
<div class="result">
  <a rel="nofollow" class="result__a" href="https://other.org/page">Other Page</a>
  <a class="result__snippet" href="#">Another snippet</a>
</div>
`;

describe('parseDuckDuckGoHtml', () => {
  it('extracts urls, titles and snippets', () => {
    const results = parseDuckDuckGoHtml(DDG_HTML, 10);
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({
      title: 'Example Docs',
      url: 'https://example.com/docs',
      snippet: 'Documentation for the "example" project',
    });
    expect(results[1]!.url).toBe('https://other.org/page');
  });

  it('respects maxResults', () => {
    expect(parseDuckDuckGoHtml(DDG_HTML, 1)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// normalizeUrl + mergeResults (dedupe + RRF re-rank)
// ---------------------------------------------------------------------------

describe('normalizeUrl', () => {
  it('strips www, trailing slash, hash and tracking params', () => {
    expect(normalizeUrl('https://www.Example.com/path/?utm_source=x&id=1#frag')).toBe(
      'https://example.com/path?id=1',
    );
  });
});

describe('mergeResults', () => {
  const r = (url: string, title = url): SearchResult => ({ url, title, snippet: '' });

  it('deduplicates urls across engines', () => {
    const merged = mergeResults(
      [
        [r('https://a.com/x'), r('https://b.com')],
        [r('https://www.a.com/x/'), r('https://c.com')],
      ],
      10,
    );
    const urls = merged.map((m) => normalizeUrl(m.url));
    expect(urls.filter((u) => u === 'https://a.com/x')).toHaveLength(1);
    expect(merged).toHaveLength(3);
  });

  it('ranks urls present in both engines first (RRF)', () => {
    const ddg = [r('https://only-ddg.com'), r('https://both.com'), r('https://ddg2.com')];
    const tavily = [r('https://only-tavily.com'), r('https://both.com')];
    const merged = mergeResults([ddg, tavily], 10);
    expect(normalizeUrl(merged[0]!.url)).toBe('https://both.com');
  });

  it('limits to topN', () => {
    const list = Array.from({ length: 30 }, (_, i) => r(`https://site${i}.com`));
    expect(mergeResults([list], 10)).toHaveLength(10);
  });
});

// ---------------------------------------------------------------------------
// web_search tool (fetch mockeado)
// ---------------------------------------------------------------------------

describe('web_search', () => {
  it('queries DDG and formats top results', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(DDG_HTML, { status: 200 })),
    );

    const result = await webSearchTool.execute({ query: 'example docs' }, makeCtx());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output).toContain('https://example.com/docs');
      expect(result.output).toContain('1. Example Docs');
    }
  });

  it('merges Tavily results when an API key is configured', async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).includes('tavily')) {
        return new Response(
          JSON.stringify({
            results: [{ title: 'Tavily Hit', url: 'https://tavily-hit.com', content: 'desc' }],
          }),
          { status: 200 },
        );
      }
      return new Response(DDG_HTML, { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await webSearchTool.execute(
      { query: 'q' },
      makeCtx({ tavilyApiKey: 'tvly-test' }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output).toContain('tavily-hit.com');
      expect(result.output).toContain('example.com/docs');
    }
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('survives a failing backend if the other succeeds', async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).includes('tavily')) throw new Error('tavily down');
      return new Response(DDG_HTML, { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await webSearchTool.execute(
      { query: 'q' },
      makeCtx({ tavilyApiKey: 'tvly-test' }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.output).toContain('Some backends failed');
  });

  it('fails recoverably when all backends fail', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      }),
    );

    const result = await webSearchTool.execute({ query: 'q' }, makeCtx());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.recoverable).toBe(true);
  });

  it('rejects tavily backend without api key', async () => {
    const result = await webSearchTool.execute(
      { query: 'q' },
      makeCtx({ backend: 'tavily' }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('API key');
  });
});

// ---------------------------------------------------------------------------
// html-to-text
// ---------------------------------------------------------------------------

describe('htmlToText', () => {
  it('removes scripts/styles and converts structure to markdown', () => {
    const html = `
      <html><head><title>My Page</title><style>.x{color:red}</style></head>
      <body>
        <script>alert(1)</script>
        <h1>Main Title</h1>
        <p>Hello <strong>world</strong> &amp; friends.</p>
        <ul><li>one</li><li>two</li></ul>
        <pre>const x = 1;</pre>
        <a href="https://example.com">a link</a>
      </body></html>`;

    const text = htmlToText(html);
    expect(text).toContain('# Main Title');
    expect(text).toContain('**world**');
    expect(text).toContain('& friends');
    expect(text).toContain('- one');
    expect(text).toContain('```\nconst x = 1;\n```');
    expect(text).toContain('[a link](https://example.com)');
    expect(text).not.toContain('alert(1)');
    expect(text).not.toContain('color:red');
  });

  it('extracts the document title', () => {
    expect(extractTitle('<title>Hi &amp; Bye</title>')).toBe('Hi & Bye');
    expect(extractTitle('<p>no title</p>')).toBeNull();
  });

  it('decodes numeric entities', () => {
    expect(decodeHtmlEntities('caf&#233; &#x41;')).toBe('café A');
  });
});

// ---------------------------------------------------------------------------
// web_fetch (fetch mockeado)
// ---------------------------------------------------------------------------

describe('web_fetch', () => {
  it('converts html responses to clean text with title header', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('<html><head><title>T</title></head><body><h2>Sec</h2><p>body text</p></body></html>', {
            status: 200,
            headers: { 'content-type': 'text/html; charset=utf-8' },
          }),
      ),
    );

    const result = await webFetchTool.execute({ url: 'https://example.com/x' }, makeCtx());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output).toContain('# T');
      expect(result.output).toContain('## Sec');
      expect(result.output).toContain('body text');
      expect(result.output).not.toContain('<p>');
    }
  });

  it('returns non-html content as-is', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('{"a": 1}', { status: 200, headers: { 'content-type': 'application/json' } }),
      ),
    );

    const result = await webFetchTool.execute({ url: 'https://api.example.com/d' }, makeCtx());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.output).toBe('{"a": 1}');
  });

  it('sends Accept header preferring markdown', async () => {
    const fetchMock = vi.fn(
      async () => new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await webFetchTool.execute({ url: 'https://example.com' }, makeCtx());
    const init = (fetchMock.mock.calls[0] as unknown as [unknown, RequestInit])[1];
    expect((init.headers as Record<string, string>).Accept).toContain('text/markdown');
  });

  it('fails recoverably on http errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 404, statusText: 'Not Found' })));

    const result = await webFetchTool.execute({ url: 'https://example.com/missing' }, makeCtx());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.recoverable).toBe(true);
      expect(result.error).toContain('404');
    }
  });
});
