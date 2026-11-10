import dns from 'node:dns';
import { isIP } from 'node:net';
import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';
import { Agent, fetch as undiciFetch } from 'undici';
import { FetchError } from './errors.js';
import { guardedLookup, isBlockedAddress, isBlockedHostname } from './ssrf.js';

export const MAX_BYTES = 1024 * 1024;
export const TIMEOUT_MS = 8000;
export const MAX_REDIRECTS = 3;
export const MAX_TEXT_CHARS = 12000;
const USER_AGENT = 'ReachGuardResearch/1.0';
const ROBOTS_TOKEN = 'reachguardresearch';

export interface SafeFetchDeps {
  resolver?: (host: string) => Promise<string[]>;
  fetchImpl?: typeof fetch;
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
  robotsCache?: Map<string, RobotRule[]>;
}

export interface SafeFetchResult {
  url: string;
  text: string;
  truncated: boolean;
}

const systemResolver = async (host: string): Promise<string[]> =>
  (await dns.promises.lookup(host, { all: true })).map((a) => a.address);

let guardedFetch: typeof fetch | undefined;
function defaultFetch(): typeof fetch {
  if (!guardedFetch) {
    const dispatcher = new Agent({ connect: { lookup: guardedLookup as never } });
    guardedFetch = ((input: string | URL, init?: RequestInit) =>
      undiciFetch(input as string, { ...(init as object), dispatcher } as never)) as unknown as typeof fetch;
  }
  return guardedFetch;
}

// ---------- robots.txt ----------

export interface RobotRule {
  allow: boolean;
  pattern: string;
}

export function parseRobots(text: string, agentToken: string): RobotRule[] {
  const groups: { agents: string[]; rules: RobotRule[] }[] = [];
  let current: { agents: string[]; rules: RobotRule[] } | null = null;
  let lastWasAgent = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    const m = /^([a-z-]+)\s*:\s*(.*)$/i.exec(line);
    if (!m) continue;
    const key = (m[1] as string).toLowerCase();
    const value = (m[2] as string).trim();
    if (key === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if ((key === 'allow' || key === 'disallow') && current) {
      lastWasAgent = false;
      if (value) current.rules.push({ allow: key === 'allow', pattern: value });
    } else {
      lastWasAgent = false;
    }
  }
  const own = groups.find((g) => g.agents.some((a) => a !== '*' && agentToken.includes(a)));
  const star = groups.find((g) => g.agents.includes('*'));
  return (own ?? star)?.rules ?? [];
}

function patternToRegex(pattern: string): RegExp {
  const anchored = pattern.endsWith('$');
  const body = (anchored ? pattern.slice(0, -1) : pattern)
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');
  return new RegExp(`^${body}${anchored ? '$' : ''}`);
}

export function robotsAllows(rules: RobotRule[], path: string): boolean {
  let best: RobotRule | null = null;
  for (const r of rules) {
    if (!patternToRegex(r.pattern).test(path)) continue;
    if (
      !best ||
      r.pattern.length > best.pattern.length ||
      (r.pattern.length === best.pattern.length && r.allow)
    )
      best = r;
  }
  return best ? best.allow : true;
}

// ---------- fetching ----------

async function validateTarget(url: URL, resolver: (host: string) => Promise<string[]>): Promise<void> {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isBlockedHostname(host)) throw new FetchError('blocked_address', `Host ${host} is not allowed`);
  if (isIP(host)) {
    if (isBlockedAddress(host)) throw new FetchError('blocked_address', `Address ${host} is not allowed`);
    return;
  }
  let addresses: string[];
  try {
    addresses = await resolver(host);
  } catch {
    throw new FetchError('dns_failed', `Could not resolve ${host}`);
  }
  if (addresses.length === 0) throw new FetchError('dns_failed', `No addresses for ${host}`);
  if (addresses.some(isBlockedAddress))
    throw new FetchError('blocked_address', `Host ${host} resolves to a blocked address`);
}

function parseTarget(raw: string | URL): URL {
  let url: URL;
  try {
    url = new URL(String(raw));
  } catch {
    throw new FetchError('invalid_url', 'Invalid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new FetchError('unsupported_protocol', `Protocol ${url.protocol} is not allowed`);
  if (url.username || url.password)
    throw new FetchError('invalid_url', 'URLs with credentials are not allowed');
  if (url.port && url.port !== '80' && url.port !== '443')
    throw new FetchError('blocked_port', `Port ${url.port} is not allowed`);
  return url;
}

async function readCapped(res: Response, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  if (!res.body) return { text: '', truncated: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (total + value.length >= maxBytes) {
      const keep = maxBytes - total;
      chunks.push(value.subarray(0, keep));
      // Truncated only if more data actually exists beyond the cap.
      truncated = value.length > keep || !(await reader.read()).done;
      void reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
    total += value.length;
  }
  return { text: new TextDecoder('utf-8').decode(Buffer.concat(chunks)), truncated };
}

interface Ctx {
  resolver: (host: string) => Promise<string[]>;
  fetchImpl: typeof fetch;
  maxBytes: number;
  maxRedirects: number;
  signal: AbortSignal;
  robotsCache: Map<string, RobotRule[]>;
}

async function robotsFor(url: URL, ctx: Ctx): Promise<RobotRule[]> {
  const cached = ctx.robotsCache.get(url.origin);
  if (cached) return cached;
  let rules: RobotRule[];
  try {
    const res = await request(new URL('/robots.txt', url.origin), ctx, {
      robots: false,
      maxBytes: 512 * 1024,
      requireText: false,
    });
    if (res.status === 200) rules = parseRobots(res.text, ROBOTS_TOKEN);
    else if (res.status >= 500) rules = [{ allow: false, pattern: '/' }];
    else rules = [];
  } catch (err) {
    if (err instanceof FetchError && (err.code === 'blocked_address' || err.code === 'dns_failed')) throw err;
    if ((err as Error).name === 'TimeoutError' || ctx.signal.aborted) throw err;
    rules = [{ allow: false, pattern: '/' }];
  }
  ctx.robotsCache.set(url.origin, rules);
  return rules;
}

async function request(
  start: URL,
  ctx: Ctx,
  opts: { robots: boolean; maxBytes: number; requireText: boolean },
): Promise<{ url: string; status: number; text: string; truncated: boolean }> {
  let url = start;
  for (let hop = 0; ; hop++) {
    await validateTarget(url, ctx.resolver);
    if (opts.robots && !robotsAllows(await robotsFor(url, ctx), url.pathname + url.search)) {
      throw new FetchError('robots_disallowed', `robots.txt disallows ${url.pathname}`);
    }
    const res = await ctx.fetchImpl(url.href, {
      redirect: 'manual',
      signal: ctx.signal,
      headers: { 'user-agent': USER_AGENT, accept: 'text/html,text/plain;q=0.9,*/*;q=0.1' },
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      void res.body?.cancel().catch(() => undefined);
      if (hop >= ctx.maxRedirects)
        throw new FetchError('too_many_redirects', `More than ${ctx.maxRedirects} redirects`);
      url = parseTarget(new URL(res.headers.get('location') as string, url));
      continue;
    }
    if (opts.requireText) {
      if (!res.ok) {
        void res.body?.cancel().catch(() => undefined);
        throw new FetchError('http_error', `HTTP ${res.status} for ${url.href}`);
      }
      const type = (res.headers.get('content-type') ?? 'text/html').toLowerCase();
      if (!type.startsWith('text/') && !type.includes('xml')) {
        void res.body?.cancel().catch(() => undefined);
        throw new FetchError('unsupported_content_type', `Content type ${type} is not supported`);
      }
    }
    const body = await readCapped(res, opts.maxBytes);
    return { url: url.href, status: res.status, ...body };
  }
}

export async function safeFetch(rawUrl: string, deps: SafeFetchDeps = {}): Promise<SafeFetchResult> {
  const signal = AbortSignal.timeout(deps.timeoutMs ?? TIMEOUT_MS);
  const ctx: Ctx = {
    resolver: deps.resolver ?? systemResolver,
    fetchImpl: deps.fetchImpl ?? defaultFetch(),
    maxBytes: deps.maxBytes ?? MAX_BYTES,
    maxRedirects: deps.maxRedirects ?? MAX_REDIRECTS,
    signal,
    robotsCache: deps.robotsCache ?? new Map(),
  };
  const start = parseTarget(rawUrl);
  try {
    const r = await request(start, ctx, { robots: true, maxBytes: ctx.maxBytes, requireText: true });
    return { url: r.url, text: r.text, truncated: r.truncated };
  } catch (err) {
    if (err instanceof FetchError) throw err;
    if (signal.aborted || (err as Error).name === 'TimeoutError' || (err as Error).name === 'AbortError') {
      throw new FetchError('timeout', 'Request timed out');
    }
    throw new FetchError('http_error', `Request failed: ${(err as Error).message}`);
  }
}

// ---------- text extraction ----------

export function extractText(html: string, url: string): string {
  if (!html.trim()) return '';
  const dom = new JSDOM(html, { url }); // scripts are not executed and subresources are not loaded by default
  const doc = dom.window.document;
  doc.querySelectorAll('script, style, noscript, template').forEach((n) => n.remove());
  let text: string;
  try {
    text = new Readability(doc.cloneNode(true) as Document).parse()?.textContent ?? '';
  } catch {
    text = '';
  }
  if (text.replace(/\s+/g, '').length < 200) text = doc.body?.textContent ?? text;
  const cleaned = text.replace(/\s+/g, ' ').trim();
  dom.window.close();
  return cleaned.length > MAX_TEXT_CHARS ? cleaned.slice(0, MAX_TEXT_CHARS).trimEnd() : cleaned;
}

// ---------- research page set ----------

export interface ResearchPages {
  pages: { url: string; text: string }[];
  skipped: { url: string; reason: string }[];
}

const GROUPS = [['/'], ['/about', '/about-us', '/company'], ['/news', '/blog', '/press', '/newsroom']];
const FATAL = new Set([
  'blocked_address',
  'blocked_port',
  'dns_failed',
  'invalid_url',
  'unsupported_protocol',
]);

export function normalizeWebsite(raw: string): URL {
  const t = raw.trim();
  return parseTarget(/^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `https://${t}`);
}

export async function fetchResearchPages(website: string, deps: SafeFetchDeps = {}): Promise<ResearchPages> {
  const out: ResearchPages = { pages: [], skipped: [] };
  let base: URL;
  try {
    base = normalizeWebsite(website);
  } catch (err) {
    out.skipped.push({ url: website, reason: err instanceof FetchError ? err.code : 'invalid_url' });
    return out;
  }
  const shared = { ...deps, robotsCache: deps.robotsCache ?? new Map<string, RobotRule[]>() };
  const seen = new Set<string>();
  for (const group of GROUPS) {
    for (const path of group) {
      const target = new URL(path, base.origin).href;
      try {
        const r = await safeFetch(target, shared);
        const text = extractText(r.text, r.url);
        if (seen.has(r.url) || !text) {
          out.skipped.push({ url: target, reason: text ? 'duplicate' : 'empty' });
          continue;
        }
        seen.add(r.url);
        out.pages.push({ url: r.url, text });
        break;
      } catch (err) {
        const code = err instanceof FetchError ? err.code : 'error';
        out.skipped.push({ url: target, reason: code });
        if (FATAL.has(code)) return out;
      }
    }
  }
  return out;
}
