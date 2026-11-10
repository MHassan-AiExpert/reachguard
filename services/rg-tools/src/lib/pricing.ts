import { readFileSync } from 'node:fs';
import path from 'node:path';

export interface ModelPrice {
  input_per_1m_usd: number | null;
  output_per_1m_usd: number | null;
}

export type Pricing = Record<string, ModelPrice>;

export function loadPricing(configDir: string): Pricing {
  try {
    const json = JSON.parse(readFileSync(path.join(configDir, 'llm-pricing.json'), 'utf8')) as {
      models?: Pricing;
    };
    return json.models ?? {};
  } catch {
    return {};
  }
}

export function computeCost(
  pricing: Pricing,
  model: string,
  inputTokens: number,
  outputTokens: number,
): { cost_usd: number; priced: boolean } {
  const p = pricing[model];
  if (!p || p.input_per_1m_usd === null || p.output_per_1m_usd === null)
    return { cost_usd: 0, priced: false };
  const cost = (inputTokens * p.input_per_1m_usd + outputTokens * p.output_per_1m_usd) / 1_000_000;
  return { cost_usd: Math.round(cost * 1e6) / 1e6, priced: true };
}
