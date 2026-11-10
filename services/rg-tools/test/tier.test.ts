import { describe, expect, it } from 'vitest';
import { computeTier } from '../src/lib/tier.js';
import { buildServer } from '../src/server.js';
import { authHeaders, testConfig } from './helpers.js';

const weights = { industry_fit: 0.3, size_fit: 0.15, role_fit: 0.25, trigger_strength: 0.2, evidence_quality: 0.1 };
const thresholds = { tier_a_min: 80, tier_b_min: 60 };
const dims = (score: number) => Object.keys(weights).map((name) => ({ name, score }));

describe('computeTier', () => {
  it('gives tier A when every dimension scores 90', () => {
    expect(computeTier(dims(90), weights, thresholds, [])).toEqual({ score: 90, tier: 'A' });
  });
  it('caps a would-be A at B for the catch_all flag', () => {
    expect(computeTier(dims(90), weights, thresholds, ['catch_all'])).toEqual({ score: 90, tier: 'B' });
  });
  it('caps a would-be A at B for thin_evidence', () => {
    expect(computeTier(dims(90), weights, thresholds, ['thin_evidence']).tier).toBe('B');
  });
  it('does not lift a B to anything because of flags', () => {
    expect(computeTier(dims(70), weights, thresholds, ['catch_all']).tier).toBe('B');
  });
  it('gives tier C for a weighted score of 55', () => {
    expect(computeTier(dims(55), weights, thresholds, [])).toEqual({ score: 55, tier: 'C' });
  });
  it('weights dimensions unequally', () => {
    const d = [
      { name: 'industry_fit', score: 100 },
      { name: 'size_fit', score: 0 },
      { name: 'role_fit', score: 100 },
      { name: 'trigger_strength', score: 0 },
      { name: 'evidence_quality', score: 0 },
    ];
    expect(computeTier(d, weights, thresholds, []).score).toBe(55);
  });
  it('treats the thresholds as inclusive', () => {
    expect(computeTier(dims(80), weights, thresholds, []).tier).toBe('A');
    expect(computeTier(dims(60), weights, thresholds, []).tier).toBe('B');
  });
  it('throws when a weighted dimension is missing', () => {
    expect(() => computeTier(dims(90).slice(1), weights, thresholds, [])).toThrow(/industry_fit/);
  });
});

describe('POST /v1/score/tier', () => {
  const app = buildServer({ config: testConfig() });
  it('uses the default weights and thresholds from config', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/score/tier',
      headers: authHeaders,
      payload: { dimensions: dims(90), flags: ['catch_all'] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ score: 90, tier: 'B' });
  });
  it('rejects a body without dimensions', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/score/tier', headers: authHeaders, payload: {} });
    expect(res.statusCode).toBe(400);
  });
  it('returns 422 when a dimension is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/score/tier',
      headers: authHeaders,
      payload: { dimensions: dims(90).slice(1) },
    });
    expect(res.statusCode).toBe(422);
  });
});
