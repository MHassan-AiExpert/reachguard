import type { OutboundMessage } from '../../lib/message.js';

export interface SendResult {
  provider_message_id: string;
  provider_ref?: string;
}

export interface SenderAdapter {
  name: string;
  /** Delivers one message or throws. Must not retry internally: the caller owns retry and idempotency. */
  send(msg: OutboundMessage): Promise<SendResult>;
}
