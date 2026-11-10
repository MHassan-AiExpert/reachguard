import { describe, expect, it } from 'vitest';
import { jaccard, shingleHashes, shingles } from '../src/lib/shingles.js';
import { buildServer } from '../src/server.js';
import { authHeaders, testConfig } from './helpers.js';
import { memoryCopyStore } from './copy-helpers.js';

const A =
  'Hi Jane, I saw that Acme launched Atlas Pro this March and is hiring twelve engineers for the warehouse robotics team. We help logistics teams cut picking errors with a small vision add on that plugs into existing robots. Would a short call next week be useful to compare notes on rollout timing?';
const A_EDITED = A.replace('saw', 'read').replace('short call', 'quick call');
const DIFFERENT =
  'Good morning Tom, your recent keynote covered battery chemistry, supply constraints and pricing pressure across the electric scooter market, so here is a different angle entirely about charging cabinets for dense urban depots. Open to a brief chat about pilots?';

describe('shingles', () => {
  it('uses 5 word windows, deduplicated, ignoring case and punctuation', () => {
    expect(shingles('one two three four five six')).toHaveLength(2);
    expect(shingles('One, two! three four... FIVE six')).toEqual(shingles('one two three four five six'));
    expect(shingles('a b c d e a b c d e')).toHaveLength(5);
  });

  it('uses one shingle for texts shorter than the window so identical short texts still match', () => {
    expect(shingles('too short text')).toHaveLength(1);
    expect(shingles('')).toEqual([]);
    expect(jaccard(shingleHashes('too short text'), shingleHashes('too short text'))).toBe(1);
  });

  it('hashes to stable decimal strings below 2^53', () => {
    const h = shingleHashes(A);
    expect(h).toEqual(shingleHashes(A));
    expect(new Set(h).size).toBe(h.length);
    for (const x of h) expect(BigInt(x) < 2n ** 53n).toBe(true);
    expect(Number.isSafeInteger(Number(h[0]))).toBe(true);
  });
});

describe('jaccard', () => {
  it('is 1 for identical sets, 0 for disjoint or empty, and symmetric', () => {
    expect(jaccard(['1', '2'], ['2', '1'])).toBe(1);
    expect(jaccard(['1'], ['2'])).toBe(0);
    expect(jaccard([], [])).toBe(0);
    expect(jaccard(['1', '2', '3'], ['2', '3', '4'])).toBe(jaccard(['2', '3', '4'], ['1', '2', '3']));
    expect(jaccard(['1', '2', '3'], ['2', '3', '4'])).toBeCloseTo(0.5, 10);
  });

  it('puts near identical bodies above 0.60 and different bodies below 0.30', () => {
    expect(jaccard(shingleHashes(A), shingleHashes(A_EDITED))).toBeGreaterThan(0.6);
    expect(jaccard(shingleHashes(A), shingleHashes(DIFFERENT))).toBeLessThan(0.3);
  });
});

describe('POST /v1/similarity', () => {
  const CAMPAIGN = '0f7c5c52-2c34-4a56-9b0e-1b2a3c4d5e6f';
  const LEAD = '3f2b8e5c-1d4a-4c6e-9a7b-0e1f2a3b4c5d';
  const OTHER_LEAD = '4a2b8e5c-1d4a-4c6e-9a7b-0e1f2a3b4c5d';
  const post = (server: ReturnType<typeof buildServer>, payload: object) =>
    server.inject({ method: 'POST', url: '/v1/similarity', headers: authHeaders, payload });

  it('returns the highest Jaccard against recent campaign drafts and flags the threshold', async () => {
    const store = memoryCopyStore({
      shingles: [
        { lead_id: OTHER_LEAD, hashes: shingleHashes(A_EDITED) },
        { lead_id: OTHER_LEAD, hashes: shingleHashes(DIFFERENT) },
      ],
    });
    const server = buildServer({ config: testConfig(), copyStore: store });
    const res = await post(server, { campaign_id: CAMPAIGN, shingle_hashes: shingleHashes(A) });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.max_similarity).toBeGreaterThan(0.6);
    expect(body.compared).toBe(2);
    expect(body.threshold).toBe(0.6);
    expect(body.exceeds_threshold).toBe(true);
    expect(store.calls[0]).toMatchObject({ campaign_id: CAMPAIGN, limit: 200 });
  });

  it('excludes the lead’s own earlier revisions so a regeneration is not compared with itself', async () => {
    const store = memoryCopyStore({ shingles: [{ lead_id: LEAD, hashes: shingleHashes(A) }] });
    const server = buildServer({ config: testConfig(), copyStore: store });
    const res = await post(server, {
      campaign_id: CAMPAIGN,
      exclude_lead_id: LEAD,
      shingle_hashes: shingleHashes(A),
    });
    expect(res.json()).toMatchObject({ max_similarity: 0, compared: 0, exceeds_threshold: false });
    expect(store.calls[0]?.exclude_lead_id).toBe(LEAD);
  });

  it('returns 0 for an empty campaign', async () => {
    const server = buildServer({ config: testConfig(), copyStore: memoryCopyStore() });
    expect(
      (await post(server, { campaign_id: CAMPAIGN, shingle_hashes: shingleHashes(A) })).json().max_similarity,
    ).toBe(0);
  });

  it('validates input and needs the database', async () => {
    const server = buildServer({ config: testConfig(), copyStore: memoryCopyStore() });
    expect((await post(server, { campaign_id: 'nope', shingle_hashes: [] })).statusCode).toBe(400);
    expect((await post(server, { campaign_id: CAMPAIGN, shingle_hashes: ['not-a-number'] })).statusCode).toBe(
      400,
    );
    const noDb = buildServer({ config: testConfig() });
    expect((await post(noDb, { campaign_id: CAMPAIGN, shingle_hashes: [] })).statusCode).toBe(503);
  });
});
