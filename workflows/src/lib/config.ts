import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

export interface Defaults {
  hygiene: Record<string, unknown>;
  scoring: { weights: Record<string, number>; tier_a_min: number; tier_b_min: number };
  qa: { max_revisions: number; spam_risk_max: number };
  approval: { reminder_hours: number; expire_hours: number };
  sending: { jitter_minutes: number; sequence_delays_business_days: number[] };
  guardian: Record<string, number>;
  retention: { raw_payload_days: number; events_days: number };
}

/** Thresholds are baked into the generated SQL at build time because n8n nodes cannot read env vars or files. */
export function loadDefaults(): Defaults {
  const path = fileURLToPath(new URL('../../../config/defaults.yaml', import.meta.url));
  return YAML.parse(readFileSync(path, 'utf8')) as Defaults;
}
