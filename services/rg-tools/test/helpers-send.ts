import type { SenderAdapter } from '../src/adapters/sender/types.js';
import type { OutboundMessage } from '../src/lib/message.js';

export interface FakeSender extends SenderAdapter {
  sent: OutboundMessage[];
  failNext: number;
  delayMs: number;
}

export function fakeSender(name = 'mailpit'): FakeSender {
  const s: FakeSender = {
    name,
    sent: [],
    failNext: 0,
    delayMs: 0,
    async send(msg) {
      if (s.delayMs) await new Promise((r) => setTimeout(r, s.delayMs));
      if (s.failNext > 0) {
        s.failNext--;
        throw new Error('smtp unavailable');
      }
      s.sent.push(msg);
      return {
        provider_message_id: msg.headers['Message-ID'] as string,
        provider_ref: `fake-${s.sent.length}`,
      };
    },
  };
  return s;
}
