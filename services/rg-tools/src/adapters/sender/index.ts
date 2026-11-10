import type { Config } from '../../config.js';
import { createMailpitSenderFromConfig } from './mailpit.js';
import { createSmartleadSender } from './smartlead.js';
import type { SenderAdapter } from './types.js';

export * from './types.js';
export { NotConfigured } from '../../lib/errors.js';

export function createSender(config: Config): SenderAdapter {
  return config.mode === 'live' ? createSmartleadSender() : createMailpitSenderFromConfig(config);
}
