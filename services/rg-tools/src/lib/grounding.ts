export interface PageText {
  url: string;
  text: string;
}

export type DropReason = 'unknown_source' | 'snippet_too_short' | 'snippet_not_in_source';

export interface GroundResult<F> {
  kept: F[];
  dropped: (F & { reason: DropReason })[];
}

const MIN_SNIPPET_CHARS = 12;

const chars = (...codes: number[]): string => codes.map((c) => String.fromCharCode(c)).join('');
// Character classes are built from code points so the source holds no invisible or look-alike characters.
const ZERO_WIDTH = new RegExp(`[${chars(0x200b)}-${chars(0x200d)}${chars(0xfeff)}]`, 'g');
const SINGLE_QUOTES = new RegExp(`[${chars(0x2018, 0x2019, 0x201a, 0x201b, 0x2032)}]`, 'g');
const DOUBLE_QUOTES = new RegExp(`[${chars(0x201c, 0x201d, 0x201e, 0x201f, 0x2033)}]`, 'g');
const DASHES = new RegExp(`[${chars(0x2010)}-${chars(0x2015)}${chars(0x2212)}]`, 'g');
const ELLIPSIS = new RegExp(chars(0x2026), 'g');

/** Whitespace, quote, dash and ellipsis normalisation. Case is deliberately preserved: snippets must be verbatim. */
export function normalizeForMatch(s: string): string {
  return s
    .replace(ZERO_WIDTH, '')
    .replace(SINGLE_QUOTES, "'")
    .replace(DOUBLE_QUOTES, '"')
    .replace(DASHES, '-')
    .replace(ELLIPSIS, '...')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.origin}${u.pathname.replace(/\/+$/, '')}${u.search}`;
  } catch {
    return raw.trim();
  }
}

export function groundFacts<F extends { source_url: string; snippet: string }>(
  facts: F[],
  pages: PageText[],
): GroundResult<F> {
  const byUrl = new Map<string, string>();
  for (const p of pages) byUrl.set(normalizeUrl(p.url), normalizeForMatch(p.text));
  const result: GroundResult<F> = { kept: [], dropped: [] };
  for (const fact of facts) {
    const text = byUrl.get(normalizeUrl(fact.source_url));
    const snippet = normalizeForMatch(fact.snippet);
    let reason: DropReason | null = null;
    if (text === undefined) reason = 'unknown_source';
    else if (snippet.length < MIN_SNIPPET_CHARS) reason = 'snippet_too_short';
    else if (!text.includes(snippet)) reason = 'snippet_not_in_source';
    if (reason) result.dropped.push({ ...fact, reason });
    else result.kept.push(fact);
  }
  return result;
}
