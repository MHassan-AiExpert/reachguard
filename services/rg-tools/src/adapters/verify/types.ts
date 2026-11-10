export type VerifyTier = 'primary' | 'escalation';
export type VerifyResultKind = 'valid' | 'invalid' | 'catch_all' | 'risky' | 'unknown';

export interface VerifyOutcome {
  result: VerifyResultKind;
  provider: string;
  cost_usd: number;
}

export interface VerifyOptions {
  /** Sandbox-only: fixture tags attached to the lead. Ignored by live adapters. */
  tags?: string[];
}

export interface Verifier {
  verify(email: string, tier: VerifyTier, opts?: VerifyOptions): Promise<VerifyOutcome>;
}

export { NotConfigured } from '../../lib/errors.js';
