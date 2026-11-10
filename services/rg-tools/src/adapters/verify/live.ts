import { NotConfigured, type Verifier } from './types.js';

// Live vendor adapters (MillionVerifier/Reoon primary, ZeroBounce escalation) are added once the
// vendor API contracts are confirmed against their current documentation. Until then live mode
// fails closed: an unverified address is never treated as valid.
export function createLiveVerifier(): Verifier {
  return {
    async verify() {
      throw new NotConfigured('Live email verification');
    },
  };
}
