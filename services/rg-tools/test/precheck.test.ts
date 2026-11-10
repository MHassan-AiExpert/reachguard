import { describe, expect, it } from 'vitest';
import { loadQaRules, precheckCopy, type CopyOutput, type QaRules } from '../src/lib/precheck.js';
import { buildServer } from '../src/server.js';
import { authHeaders, testConfig } from './helpers.js';
import { memoryCopyStore } from './copy-helpers.js';

const LEAD = '3f2b8e5c-1d4a-4c6e-9a7b-0e1f2a3b4c5d';
const EV1 = '11111111-1111-4111-8111-111111111111';
const EV_OTHER = '22222222-2222-4222-8222-222222222222';

const RULES: QaRules = {
  step1_words: [50, 110],
  followup_words: [30, 80],
  subject_max_chars: 60,
  similarity_threshold: 0.6,
  banned_phrases: ['act now', 'limited time', 'guarantee', 'i hope this email finds you well'],
};

/** n distinct words ending in a single question mark so the CTA rule is satisfied. */
const words = (n: number, tag = 'w', question = true): string => {
  const body = Array.from({ length: n }, (_, i) => `${tag}${i}`).join(' ');
  return question ? `${body}?` : body;
};

function copy(
  over: Partial<{
    s1: string;
    subject1: string | null;
    s2: string;
    subject2: string | null;
    claims: { text: string; evidence_id: string }[];
  }> = {},
): CopyOutput {
  return {
    variant_label: 'direct',
    sequence: [
      {
        step: 1,
        subject: over.subject1 === undefined ? 'quick question about atlas' : over.subject1,
        body: over.s1 ?? words(80),
        claims: over.claims ?? [{ text: 'Launched Atlas Pro', evidence_id: EV1 }],
      },
      {
        step: 2,
        subject: over.subject2 === undefined ? null : over.subject2,
        body: over.s2 ?? words(50, 'f', false),
        claims: [],
      },
    ],
  };
}

const ctx = { lead_id: LEAD, evidenceIds: new Set([EV1]), rules: RULES };
const has = (c: CopyOutput, code: string, context = ctx) =>
  precheckCopy(c, context).violations.some((v) => v.includes(code));

describe('precheckCopy', () => {
  it('passes a well formed sequence and returns numeric shingle hashes under 2^53', () => {
    const r = precheckCopy(copy(), ctx);
    expect(r).toMatchObject({ ok: true, violations: [] });
    expect(r.shingle_hashes.length).toBeGreaterThan(0);
    for (const h of r.shingle_hashes) {
      expect(h).toMatch(/^\d+$/);
      expect(BigInt(h) < 2n ** 53n).toBe(true);
    }
  });

  it('fails a 40 word first email, passes 50 and 110, fails 111', () => {
    expect(has(copy({ s1: words(40) }), 'words_too_few')).toBe(true);
    expect(precheckCopy(copy({ s1: words(50) }), ctx).ok).toBe(true);
    expect(precheckCopy(copy({ s1: words(110) }), ctx).ok).toBe(true);
    expect(has(copy({ s1: words(111) }), 'words_too_many')).toBe(true);
  });

  it('applies the follow-up word range to steps 2 and later', () => {
    expect(has(copy({ s2: words(20, 'f', false) }), 'step2:words_too_few')).toBe(true);
    expect(has(copy({ s2: words(90, 'f', false) }), 'step2:words_too_many')).toBe(true);
  });

  it.each([
    'see https://acme.example/demo',
    'visit www.acme.example today',
    'details at acme.com',
    'mail me at jo@acme.io',
  ])('fails a link in step 1: %s', (frag) => {
    expect(has(copy({ s1: `${words(75, 'a', false)} ${frag} ${words(1)}` }), 'link_in_first_email')).toBe(
      true,
    );
  });

  it('allows a link in a follow-up', () => {
    expect(precheckCopy(copy({ s2: `${words(45, 'f', false)} https://cal.com/x` }), ctx).ok).toBe(true);
  });

  it('fails banned phrases in body or subject, ignoring case and curly apostrophes', () => {
    expect(has(copy({ s1: `${words(70, 'a', false)} ACT NOW ${words(1)}` }), 'banned_phrase')).toBe(true);
    expect(has(copy({ subject1: 'Limited time offer' }), 'banned_phrase')).toBe(true);
    expect(has(copy({ s2: `${words(45, 'f', false)} We guarantee results` }), 'banned_phrase')).toBe(true);
    const curly = { ...ctx, rules: { ...RULES, banned_phrases: ["don't miss out"] } };
    expect(
      has(copy({ s1: `${words(70, 'a', false)} Don’t miss out ${words(1)}` }), 'banned_phrase', curly),
    ).toBe(true);
  });

  it('fails a subject over 60 characters, a missing step 1 subject, and an empty subject', () => {
    expect(has(copy({ subject1: 'x'.repeat(61) }), 'subject_too_long')).toBe(true);
    expect(precheckCopy(copy({ subject1: 'x'.repeat(60) }), ctx).ok).toBe(true);
    expect(has(copy({ subject1: null }), 'subject_missing')).toBe(true);
    expect(has(copy({ subject1: '   ' }), 'subject_missing')).toBe(true);
  });

  it.each(['Re: your note', 'RE: hello', 're:hello', 'Fwd: intro', 'FW: intro', 'Fw: x'])(
    'fails fake reply or forward subject %s',
    (subject) => {
      expect(has(copy({ subject1: subject }), 'fake_reply_prefix')).toBe(true);
    },
  );

  it('fails a follow-up with a non-null subject', () => {
    expect(has(copy({ subject2: 'checking in' }), 'step2:subject_not_null')).toBe(true);
  });

  it('fails when a claim cites an evidence id that is not this lead’s (Review Focus 4)', () => {
    const r = precheckCopy(copy({ claims: [{ text: 'Raised a round', evidence_id: EV_OTHER }] }), ctx);
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.includes('claim_evidence_not_owned') && v.includes(EV_OTHER))).toBe(
      true,
    );
  });

  it('checks claims in follow-ups too, and passes when every claim is owned', () => {
    const c = copy();
    (c.sequence[1] as { claims: { text: string; evidence_id: string }[] }).claims = [
      { text: 'x', evidence_id: EV_OTHER },
    ];
    expect(has(c, 'step2:claim_evidence_not_owned')).toBe(true);
  });

  it('requires exactly one question in the first email', () => {
    expect(has(copy({ s1: words(80, 'a', false) }), 'cta_question_count')).toBe(true);
    expect(has(copy({ s1: `${words(40, 'a')} ${words(40, 'b')}` }), 'cta_question_count')).toBe(true);
  });

  it('rejects emoji in the first email but not in follow-ups', () => {
    expect(has(copy({ s1: `${words(79)} \u{1F680}` }), 'emoji_in_first_email')).toBe(true);
    expect(has(copy({ subject1: 'launch \u{1F680}' }), 'emoji_in_first_email')).toBe(true);
    expect(precheckCopy(copy({ s2: `${words(45, 'f', false)} \u{1F642}` }), ctx).ok).toBe(true);
  });

  it('requires steps numbered 1..n in order', () => {
    const c = copy();
    (c.sequence[1] as { step: number }).step = 3;
    expect(has(c, 'sequence_order')).toBe(true);
    const d = copy();
    d.sequence.reverse();
    expect(has(d, 'sequence_order')).toBe(true);
  });

  it('is stable: the same copy always yields the same hashes, and an empty body does not throw', () => {
    expect(precheckCopy(copy(), ctx).shingle_hashes).toEqual(precheckCopy(copy(), ctx).shingle_hashes);
    expect(has(copy({ s1: '' }), 'words_too_few')).toBe(true);
  });

  it('collects every violation instead of stopping at the first', () => {
    const r = precheckCopy(copy({ s1: words(10, 'a', false), subject1: 'Re: x' }), ctx);
    expect(r.violations.length).toBeGreaterThanOrEqual(3);
  });
});

describe('loadQaRules', () => {
  it('reads the qa section of config/defaults.yaml', () => {
    const r = loadQaRules(testConfig().configDir);
    expect(r.step1_words).toEqual([50, 110]);
    expect(r.followup_words).toEqual([30, 80]);
    expect(r.subject_max_chars).toBe(60);
    expect(r.similarity_threshold).toBe(0.6);
    expect(r.banned_phrases).toContain('act now');
  });
});

describe('POST /v1/copy/precheck', () => {
  const post = (server: ReturnType<typeof buildServer>, payload: object) =>
    server.inject({ method: 'POST', url: '/v1/copy/precheck', headers: authHeaders, payload });

  it('uses evidence ids from the request and returns ok with hashes', async () => {
    const server = buildServer({ config: testConfig() });
    const res = await post(server, { lead_id: LEAD, copy: copy(), evidence_ids: [EV1] });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, violations: [] });
    expect(res.json().shingle_hashes.length).toBeGreaterThan(0);
  });

  it('looks up the lead’s evidence ids when none are supplied', async () => {
    const store = memoryCopyStore({ evidence: { [LEAD]: [EV1] } });
    const server = buildServer({ config: testConfig(), copyStore: store });
    expect((await post(server, { lead_id: LEAD, copy: copy() })).json().ok).toBe(true);
    const bad = await post(server, {
      lead_id: LEAD,
      copy: copy({ claims: [{ text: 'x', evidence_id: EV_OTHER }] }),
    });
    expect(bad.json().ok).toBe(false);
  });

  it('returns 503 when it needs the database and has none', async () => {
    const server = buildServer({ config: testConfig() });
    expect((await post(server, { lead_id: LEAD, copy: copy() })).statusCode).toBe(503);
  });

  it('merges extra banned phrases from the campaign', async () => {
    const server = buildServer({ config: testConfig() });
    const res = await post(server, {
      lead_id: LEAD,
      copy: copy({ subject1: 'synergy unlocked' }),
      evidence_ids: [EV1],
      extra_banned_phrases: ['synergy'],
    });
    expect(res.json().ok).toBe(false);
  });

  it('reports schema problems as violations instead of crashing', async () => {
    const server = buildServer({ config: testConfig() });
    const res = await post(server, {
      lead_id: LEAD,
      copy: { variant_label: 'x', sequence: [] },
      evidence_ids: [],
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(false);
    expect(res.json().violations.some((v: string) => v.startsWith('schema:'))).toBe(true);
  });

  it('returns 400 for a malformed request', async () => {
    const server = buildServer({ config: testConfig() });
    expect((await post(server, { lead_id: 'nope', copy: {} })).statusCode).toBe(400);
  });
});
