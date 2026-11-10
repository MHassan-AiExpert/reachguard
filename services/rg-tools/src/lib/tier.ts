import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';

export interface Dimension {
  name: string;
  score: number;
}
export interface TierThresholds {
  tier_a_min: number;
  tier_b_min: number;
}
export interface ScoringRules extends TierThresholds {
  weights: Record<string, number>;
  /** Flags that cap the tier at B. */
  cap_flags: string[];
}
export type Tier = 'A' | 'B' | 'C';

/** Weighted score of the dimensions, then a tier from the thresholds. Flags can lower an A to B, never raise anything. */
export function computeTier(
  dimensions: Dimension[],
  weights: Record<string, number>,
  thresholds: TierThresholds,
  flags: string[],
  capFlags: string[] = ['catch_all', 'thin_evidence'],
): { score: number; tier: Tier } {
  const byName = new Map(dimensions.map((d) => [d.name, d.score]));
  let total = 0;
  for (const [name, weight] of Object.entries(weights)) {
    const s = byName.get(name);
    if (s === undefined) throw new Error(`missing dimension: ${name}`);
    total += weight * s;
  }
  const score = Math.round(total * 100) / 100;
  let tier: Tier = score >= thresholds.tier_a_min ? 'A' : score >= thresholds.tier_b_min ? 'B' : 'C';
  if (tier === 'A' && flags.some((f) => capFlags.includes(f))) tier = 'B';
  return { score, tier };
}

export function loadScoringRules(configDir: string): ScoringRules {
  const doc = parse(readFileSync(path.join(configDir, 'defaults.yaml'), 'utf8')) as {
    scoring: { weights: Record<string, number>; tier_a_min: number; tier_b_min: number; cap_tier_when: Record<string, string> };
  };
  const s = doc.scoring;
  return {
    weights: s.weights,
    tier_a_min: s.tier_a_min,
    tier_b_min: s.tier_b_min,
    cap_flags: Object.entries(s.cap_tier_when).filter(([, t]) => t === 'B').map(([k]) => k),
  };
}
