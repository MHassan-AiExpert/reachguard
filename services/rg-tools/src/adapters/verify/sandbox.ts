import type { Verifier, VerifyOutcome, VerifyResultKind } from './types.js';

export function createSandboxVerifier(): Verifier {
  return {
    async verify(_email, tier, opts): Promise<VerifyOutcome> {
      const tags = new Set(opts?.tags ?? []);
      let result: VerifyResultKind = 'valid';
      if (tags.has('invalid')) result = 'invalid';
      else if (tags.has('catch_all')) result = 'catch_all';
      else if (tags.has('unknown')) result = 'unknown';
      else if (tags.has('risky')) result = tier === 'escalation' ? 'valid' : 'risky';
      return { result, provider: 'sandbox', cost_usd: 0 };
    },
  };
}
