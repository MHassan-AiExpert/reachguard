import type { Config } from '../../config.js';
import { createLiveVerifier } from './live.js';
import { createSandboxVerifier } from './sandbox.js';
import type { Verifier } from './types.js';

export * from './types.js';

export function createVerifier(config: Config): Verifier {
  return config.mode === 'live' ? createLiveVerifier() : createSandboxVerifier();
}
