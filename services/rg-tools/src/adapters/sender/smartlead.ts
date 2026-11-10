import { NotConfigured } from '../../lib/errors.js';
import type { SenderAdapter } from './types.js';

// The live adapter is written in Task 15 after Smartlead's current API (campaigns, lead custom fields,
// webhooks) is confirmed against its official documentation. Until then live sending fails closed.
export function createSmartleadSender(): SenderAdapter {
  return {
    name: 'smartlead',
    async send() {
      throw new NotConfigured('Smartlead sender');
    },
  };
}
