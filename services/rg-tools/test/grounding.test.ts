import { describe, expect, it } from 'vitest';
import { groundFacts, normalizeForMatch } from '../src/lib/grounding.js';

const page = {
  url: 'https://acme.example/news',
  text: 'Acme   Robotics launched “Atlas Pro”\nin March 2026 — a warehouse robot.  We’re hiring 12 engineers.',
};
const fact = (snippet: string, source_url = 'https://acme.example/news') => ({
  fact_type: 'trigger_event',
  claim: 'c',
  source_url,
  snippet,
  confidence: 0.9,
});

describe('normalizeForMatch', () => {
  it('collapses whitespace and straightens quotes, dashes and ellipses', () => {
    expect(normalizeForMatch(' a  “b”\n‘c’ — d… ')).toBe('a "b" \'c\' - d...');
  });
});

describe('groundFacts', () => {
  it('keeps a verbatim snippet, tolerating whitespace and curly-quote differences', () => {
    const r = groundFacts([fact('launched "Atlas Pro" in March 2026')], [page]);
    expect(r.kept).toHaveLength(1);
    expect(r.dropped).toHaveLength(0);
  });

  it('keeps a snippet that spans a line break and apostrophe style change', () => {
    expect(groundFacts([fact("We're hiring 12 engineers.")], [page]).kept).toHaveLength(1);
  });

  it('drops a paraphrased snippet', () => {
    const r = groundFacts([fact('Acme introduced the Atlas Pro robot in spring 2026')], [page]);
    expect(r.kept).toHaveLength(0);
    expect(r.dropped[0]).toMatchObject({ reason: 'snippet_not_in_source' });
  });

  it('is case sensitive because the snippet must be verbatim', () => {
    expect(groundFacts([fact('LAUNCHED "ATLAS PRO" IN MARCH 2026')], [page]).kept).toHaveLength(0);
  });

  it('drops a snippet that exists on a different page than the cited one', () => {
    const other = {
      url: 'https://acme.example/about',
      text: 'We build cheerful warehouse robots every day.',
    };
    const r = groundFacts([fact('We build cheerful warehouse robots every day.')], [page, other]);
    expect(r.dropped[0]).toMatchObject({ reason: 'snippet_not_in_source' });
  });

  it('drops a fact citing a URL that was never fetched', () => {
    const r = groundFacts([fact('launched "Atlas Pro" in March 2026', 'https://evil.example/')], [page]);
    expect(r.dropped[0]).toMatchObject({ reason: 'unknown_source' });
  });

  it('matches source URLs ignoring a trailing slash, fragment and host case', () => {
    const r = groundFacts(
      [fact('launched "Atlas Pro" in March 2026', 'https://ACME.example/news/#top')],
      [page],
    );
    expect(r.kept).toHaveLength(1);
  });

  it('drops snippets too short to be meaningful evidence', () => {
    const r = groundFacts([fact('Acme')], [page]);
    expect(r.dropped[0]).toMatchObject({ reason: 'snippet_too_short' });
  });

  it('partitions a mixed list preserving order', () => {
    const r = groundFacts(
      [
        fact('launched "Atlas Pro" in March 2026'),
        fact('totally made up statement here'),
        fact('We’re hiring 12 engineers.'),
      ],
      [page],
    );
    expect(r.kept.map((f) => f.snippet)).toEqual([
      'launched "Atlas Pro" in March 2026',
      'We’re hiring 12 engineers.',
    ]);
    expect(r.dropped).toHaveLength(1);
  });
});
