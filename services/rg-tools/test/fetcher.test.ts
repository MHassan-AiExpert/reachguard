import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  extractText,
  fetchResearchPages,
  parseRobots,
  robotsAllows,
  safeFetch,
  type SafeFetchDeps,
} from '../src/lib/fetcher.js';
import { buildServer } from '../src/server.js';
import { authHeaders, testConfig } from './helpers.js';

type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>;

function deps(
  routes: Record<string, Handler | Response | string>,
  dns: Record<string, string[]> = {},
): SafeFetchDeps & { seen: string[] } {
  const seen: string[] = [];
  return {
    seen,
    resolver: async (host) => dns[host] ?? ['93.184.216.34'],
    fetchImpl: (async (input: string | URL, init: RequestInit = {}) => {
      const url = new URL(String(input));
      seen.push(url.href);
      const hit = routes[url.href] ?? routes[url.origin + url.pathname];
      if (hit === undefined) return new Response('not found', { status: 404 });
      if (typeof hit === 'function') return hit(url, init);
      if (typeof hit === 'string')
        return new Response(hit, { status: 200, headers: { 'content-type': 'text/html' } });
      // Rebuild a fresh Response each time: cloning would tee the body and make cancel() wait on the other branch.
      return new Response(hit.body ? await hit.clone().arrayBuffer() : null, {
        status: hit.status,
        headers: hit.headers,
      });
    }) as unknown as typeof fetch,
  };
}

const html = (body: string, status = 200) =>
  new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
const redirect = (to: string) => new Response(null, { status: 302, headers: { location: to } });

describe('safeFetch protections', () => {
  it('rejects non-http(s) schemes', async () => {
    await expect(safeFetch('file:///etc/passwd', deps({}))).rejects.toMatchObject({
      code: 'unsupported_protocol',
    });
    await expect(safeFetch('ftp://example.com/x', deps({}))).rejects.toMatchObject({
      code: 'unsupported_protocol',
    });
  });

  it('rejects malformed URLs, embedded credentials and odd ports', async () => {
    await expect(safeFetch('not a url', deps({}))).rejects.toMatchObject({ code: 'invalid_url' });
    await expect(safeFetch('https://user:pw@example.com/', deps({}))).rejects.toMatchObject({
      code: 'invalid_url',
    });
    await expect(safeFetch('http://example.com:6379/', deps({}))).rejects.toMatchObject({
      code: 'blocked_port',
    });
  });

  it.each([
    'http://127.0.0.1/',
    'http://localhost/',
    'http://10.0.0.1/',
    'http://169.254.169.254/latest/meta-data/',
    'http://[::1]/',
    'http://2130706433/',
  ])('blocks %s and never calls fetch', async (u) => {
    const d = deps({});
    await expect(safeFetch(u, d)).rejects.toMatchObject({ code: 'blocked_address' });
    expect(d.seen).toHaveLength(0);
  });

  it('blocks a hostname that resolves to a private address', async () => {
    const d = deps({}, { 'intranet.example.com': ['10.1.2.3'] });
    await expect(safeFetch('https://intranet.example.com/', d)).rejects.toMatchObject({
      code: 'blocked_address',
    });
    expect(d.seen).toHaveLength(0);
  });

  it('blocks a hostname if any resolved address is private', async () => {
    const d = deps({}, { 'mixed.example.com': ['93.184.216.34', '192.168.0.9'] });
    await expect(safeFetch('https://mixed.example.com/', d)).rejects.toMatchObject({
      code: 'blocked_address',
    });
  });

  it('blocks a redirect to loopback', async () => {
    const d = deps({ 'https://example.com/': redirect('http://127.0.0.1/admin') });
    await expect(safeFetch('https://example.com/', d)).rejects.toMatchObject({ code: 'blocked_address' });
    expect(d.seen.some((u) => u.includes('127.0.0.1'))).toBe(false);
  });

  it('blocks a redirect to a name that resolves privately', async () => {
    const d = deps(
      { 'https://example.com/': redirect('https://evil.example.org/') },
      { 'evil.example.org': ['10.0.0.8'] },
    );
    await expect(safeFetch('https://example.com/', d)).rejects.toMatchObject({ code: 'blocked_address' });
  });

  it('follows up to 3 redirects, resolving relative locations, and fails on the fourth', async () => {
    const ok = deps({
      'https://a.example.com/': redirect('/b'),
      'https://a.example.com/b': redirect('/c'),
      'https://a.example.com/c': redirect('/d'),
      'https://a.example.com/d': html('<p>done here</p>'),
    });
    const r = await safeFetch('https://a.example.com/', ok);
    expect(r.url).toBe('https://a.example.com/d');
    expect(r.text).toContain('done here');

    const tooMany = deps({
      'https://a.example.com/': redirect('/b'),
      'https://a.example.com/b': redirect('/c'),
      'https://a.example.com/c': redirect('/d'),
      'https://a.example.com/d': redirect('/e'),
    });
    await expect(safeFetch('https://a.example.com/', tooMany)).rejects.toMatchObject({
      code: 'too_many_redirects',
    });
  });

  it('truncates a 2 MB body at 1 MB', async () => {
    const d = deps({ 'https://big.example.com/': html('a'.repeat(2 * 1024 * 1024)) });
    const r = await safeFetch('https://big.example.com/', d);
    expect(r.text.length).toBe(1024 * 1024);
    expect(r.truncated).toBe(true);
  });

  it('does not flag a small body as truncated', async () => {
    const r = await safeFetch(
      'https://s.example.com/',
      deps({ 'https://s.example.com/': html('<p>hi</p>') }),
    );
    expect(r.truncated).toBe(false);
  });

  it('times out slow servers', async () => {
    const d = deps({
      'https://slow.example.com/': (_u, init) =>
        new Promise<Response>((_res, rej) =>
          init.signal?.addEventListener('abort', () => rej(init.signal?.reason)),
        ),
    });
    await expect(safeFetch('https://slow.example.com/', { ...d, timeoutMs: 50 })).rejects.toMatchObject({
      code: 'timeout',
    });
  });

  it('rejects non-text content types and error statuses', async () => {
    const d = deps({
      'https://x.example.com/img': new Response('xx', {
        status: 200,
        headers: { 'content-type': 'image/png' },
      }),
      'https://x.example.com/err': html('oops', 500),
    });
    await expect(safeFetch('https://x.example.com/img', d)).rejects.toMatchObject({
      code: 'unsupported_content_type',
    });
    await expect(safeFetch('https://x.example.com/err', d)).rejects.toMatchObject({ code: 'http_error' });
  });
});

describe('robots.txt', () => {
  const robots =
    'User-agent: *\nDisallow: /private\nAllow: /private/open\n\nUser-agent: reachguardresearch\nDisallow: /blocked$\n';

  it('applies the most specific matching group and longest-match rule', () => {
    const star = parseRobots(
      'User-agent: *\nDisallow: /private\nAllow: /private/open\n',
      'reachguardresearch',
    );
    expect(robotsAllows(star, '/private/x')).toBe(false);
    expect(robotsAllows(star, '/private/open/y')).toBe(true);
    expect(robotsAllows(star, '/public')).toBe(true);
    const own = parseRobots(robots, 'reachguardresearch');
    expect(robotsAllows(own, '/blocked')).toBe(false);
    expect(robotsAllows(own, '/blocked/more')).toBe(true);
    expect(robotsAllows(own, '/private')).toBe(true);
  });

  it('treats an empty Disallow as allow-all and supports * wildcards', () => {
    expect(robotsAllows(parseRobots('User-agent: *\nDisallow:\n', 'x'), '/anything')).toBe(true);
    expect(robotsAllows(parseRobots('User-agent: *\nDisallow: /*.pdf$\n', 'x'), '/a/b.pdf')).toBe(false);
  });

  it('refuses a page robots.txt disallows, without fetching the page', async () => {
    const d = deps({
      'https://r.example.com/robots.txt': new Response('User-agent: *\nDisallow: /about\n', {
        headers: { 'content-type': 'text/plain' },
      }),
      'https://r.example.com/about': html('<p>secret</p>'),
    });
    await expect(safeFetch('https://r.example.com/about', d)).rejects.toMatchObject({
      code: 'robots_disallowed',
    });
    expect(d.seen).not.toContain('https://r.example.com/about');
  });

  it('allows fetching when robots.txt is missing (404)', async () => {
    const d = deps({ 'https://r.example.com/about': html('<p>fine text here</p>') });
    expect((await safeFetch('https://r.example.com/about', d)).text).toContain('fine text');
  });

  it('treats an unavailable robots.txt (5xx) as disallow-all', async () => {
    const d = deps({
      'https://r.example.com/robots.txt': new Response('x', { status: 503 }),
      'https://r.example.com/about': html('<p>nope</p>'),
    });
    await expect(safeFetch('https://r.example.com/about', d)).rejects.toMatchObject({
      code: 'robots_disallowed',
    });
  });
});

describe('extractText', () => {
  it('extracts readable text without scripts or styles', () => {
    const t = extractText(
      '<html><head><title>T</title><style>.a{}</style></head><body><nav>menu</nav><article><h1>Acme builds robots</h1><p>We make warehouse robots for logistics firms across Europe and the United States, shipping since 2019.</p></article><script>var secret=1</script></body></html>',
      'https://acme.example/',
    );
    expect(t).toContain('Acme builds robots');
    expect(t).toContain('warehouse robots');
    expect(t).not.toContain('secret');
    expect(t).not.toContain('.a{}');
  });

  it('does not execute scripts in the page', () => {
    (globalThis as Record<string, unknown>).__rg_pwned = false;
    extractText(
      '<body><p>hello there friend, this is a long enough paragraph of text.</p><script>globalThis.__rg_pwned = true</script></body>',
      'https://x.example/',
    );
    expect((globalThis as Record<string, unknown>).__rg_pwned).toBe(false);
  });

  it('falls back to body text when Readability finds no article, and caps at 12,000 characters', () => {
    const t = extractText(`<body><div>${'word '.repeat(6000)}</div></body>`, 'https://x.example/');
    expect(t.length).toBeLessThanOrEqual(12000);
    expect(t.length).toBeGreaterThan(5000);
  });

  it('returns an empty string for an empty document', () => {
    expect(extractText('', 'https://x.example/')).toBe('');
  });
});

describe('fetchResearchPages', () => {
  const page = (t: string) =>
    html(
      `<html><body><article><h1>${t}</h1><p>${t} — a reasonably long paragraph so extraction keeps it, with several words in it.</p></article></body></html>`,
    );

  it('fetches home, about and news pages (3 max) and records skipped ones', async () => {
    const d = deps({
      'https://acme.example/': page('Home'),
      'https://acme.example/about': page('About'),
      'https://acme.example/news': page('News'),
      'https://acme.example/blog': page('Blog'),
    });
    const r = await fetchResearchPages('https://acme.example', d);
    expect(r.pages.map((p) => p.url)).toEqual([
      'https://acme.example/',
      'https://acme.example/about',
      'https://acme.example/news',
    ]);
    expect(r.pages[0]?.text).toContain('Home');
    expect(d.seen).not.toContain('https://acme.example/blog');
  });

  it('falls back to alternative paths and tolerates missing pages', async () => {
    const d = deps({
      'https://acme.example/': page('Home'),
      'https://acme.example/about-us': page('AboutUs'),
      'https://acme.example/blog': page('Blog'),
    });
    const r = await fetchResearchPages('acme.example', d);
    expect(r.pages.map((p) => p.url)).toEqual([
      'https://acme.example/',
      'https://acme.example/about-us',
      'https://acme.example/blog',
    ]);
    expect(r.skipped.some((s) => s.url.endsWith('/about'))).toBe(true);
  });

  it('returns no pages and reports why when the site is blocked', async () => {
    const r = await fetchResearchPages('http://10.0.0.1', deps({}));
    expect(r.pages).toEqual([]);
    expect(r.skipped[0]?.reason).toBe('blocked_address');
  });
});

describe('research routes', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'rg-sites-'));
  mkdirSync(path.join(dir, 'acme-robotics'));
  writeFileSync(
    path.join(dir, 'acme-robotics', 'index.html'),
    '<html><body><article><h1>Acme Robotics</h1><p>Acme Robotics builds warehouse picking robots for mid-size logistics companies in Europe.</p></article></body></html>',
  );
  writeFileSync(
    path.join(dir, 'acme-robotics', 'news.html'),
    '<html><body><article><h1>News</h1><p>Acme launched Atlas Pro in March 2026 and is hiring twelve engineers.</p></article></body></html>',
  );
  const app = buildServer({ config: testConfig({ mode: 'sandbox', sandboxSitesDir: dir }) });
  const post = (url: string, payload: object) =>
    app.inject({ method: 'POST', url, headers: authHeaders, payload });

  it('serves fixture pages from the sandbox fixture directory', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/sandbox/sites/acme-robotics',
      headers: authHeaders,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('Acme Robotics');
    const news = await app.inject({
      method: 'GET',
      url: '/sandbox/sites/acme-robotics/news',
      headers: authHeaders,
    });
    expect(news.body).toContain('Atlas Pro');
  });

  it('404s unknown fixtures and rejects path traversal', async () => {
    expect(
      (await app.inject({ method: 'GET', url: '/sandbox/sites/nope', headers: authHeaders })).statusCode,
    ).toBe(404);
    expect(
      (await app.inject({ method: 'GET', url: '/sandbox/sites/..%2F..%2Fetc/passwd', headers: authHeaders }))
        .statusCode,
    ).toBe(404);
  });

  it('does not serve fixtures in live mode', async () => {
    const live = buildServer({ config: testConfig({ mode: 'live', sandboxSitesDir: dir }) });
    expect(
      (await live.inject({ method: 'GET', url: '/sandbox/sites/acme-robotics', headers: authHeaders }))
        .statusCode,
    ).toBe(404);
  });

  it('research/fetch in sandbox mode reads fixtures without any network access', async () => {
    const res = await post('/v1/research/fetch', { website: 'https://www.acme-robotics.example' });
    expect(res.statusCode).toBe(200);
    const pages = res.json().pages as { url: string; text: string }[];
    expect(pages.map((p) => p.url)).toEqual([
      'https://www.acme-robotics.example/',
      'https://www.acme-robotics.example/news',
    ]);
    expect(pages[1]?.text).toContain('Atlas Pro');
  });

  it('research/fetch returns no pages for an unknown sandbox site', async () => {
    const res = await post('/v1/research/fetch', { domain: 'unknown-co.example' });
    expect(res.statusCode).toBe(200);
    expect(res.json().pages).toEqual([]);
  });

  it('research/fetch requires website or domain', async () => {
    expect((await post('/v1/research/fetch', {})).statusCode).toBe(400);
  });

  it('research/ground partitions facts', async () => {
    const pages = [{ url: 'https://acme.example/news', text: 'Acme launched Atlas Pro in March 2026.' }];
    const facts = [
      {
        fact_type: 'trigger_event',
        claim: 'c',
        source_url: 'https://acme.example/news',
        snippet: 'Acme launched Atlas Pro in March 2026.',
        confidence: 1,
      },
      {
        fact_type: 'other',
        claim: 'c',
        source_url: 'https://acme.example/news',
        snippet: 'Acme won a big award last week',
        confidence: 1,
      },
    ];
    const res = await post('/v1/research/ground', { facts, pages });
    expect(res.statusCode).toBe(200);
    const b = res.json();
    expect(b.kept).toHaveLength(1);
    expect(b.dropped).toHaveLength(1);
    expect(b.dropped[0].reason).toBe('snippet_not_in_source');
    expect(b.kept_count).toBe(1);
    expect(b.dropped_count).toBe(1);
  });

  it('research/ground validates input', async () => {
    expect((await post('/v1/research/ground', { facts: 'x', pages: [] })).statusCode).toBe(400);
  });
});
