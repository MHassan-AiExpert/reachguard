import { signUnsubscribeToken } from './tokens.js';

export interface MessageConfig {
  publicBaseUrl: string;
  unsubscribeSecret: string;
  senderPhysicalAddress: string;
}

export interface DraftInput {
  send_id: string;
  step: number;
  subject: string | null;
  body: string;
  /** Earlier sent messages in this sequence, so follow-ups thread under the first email. */
  thread?: { subject: string; message_ids: string[] };
}

export interface LeadInput {
  id: string;
  email: string;
  first_name?: string | null;
}

export interface InboxInput {
  email: string;
  display_name?: string | null;
}

export interface OutboundMessage {
  headers: Record<string, string>;
  text: string;
}

const clean = (v: string): string => v.replace(/[\r\n]+/g, ' ').trim();
const ADDRESS_RE = /^[^\s<>"'\\]+@[^\s<>"'\\]+$/;

function address(value: string, what: string): string {
  const v = clean(value);
  if (!ADDRESS_RE.test(v)) throw new Error(`Invalid ${what} address`);
  return v;
}

/**
 * Builds the final plain text message: body, physical address, visible unsubscribe link, and headers
 * (RFC 8058 one-click, threading, deterministic Message-ID). No tracking pixel and no link rewriting.
 */
export function buildMessage(
  draft: DraftInput,
  lead: LeadInput,
  inbox: InboxInput,
  cfg: MessageConfig,
): OutboundMessage {
  const physical = cfg.senderPhysicalAddress.replace(/\s*[\r\n]+\s*/g, ', ').trim();
  if (!physical)
    throw new Error('A sender physical address is required in every email (SENDER_PHYSICAL_ADDRESS)');

  const subject = clean(
    draft.step === 1 ? (draft.subject ?? '') : (draft.thread?.subject ?? draft.subject ?? ''),
  );
  if (!subject) throw new Error(`Step ${draft.step} has no subject to send`);

  const from = address(inbox.email, 'sender');
  const to = address(lead.email, 'recipient');
  const domain = from.split('@')[1] as string;
  const base = cfg.publicBaseUrl.replace(/\/+$/, '');
  const unsubscribeUrl = `${base}/u/${signUnsubscribeToken(lead.id, cfg.unsubscribeSecret)}`;
  const displayName = clean((inbox.display_name ?? '').replace(/["\\]/g, ' '));

  const headers: Record<string, string> = {
    From: displayName ? `"${displayName}" <${from}>` : from,
    To: to,
    Subject: subject,
    'Message-ID': `<${draft.send_id}@${domain}>`,
    'MIME-Version': '1.0',
    'Content-Type': 'text/plain; charset=utf-8',
    'List-Unsubscribe': `<${unsubscribeUrl}>, <mailto:${from}?subject=unsubscribe>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  };
  const ids = (draft.thread?.message_ids ?? []).map(clean).filter(Boolean);
  if (ids.length > 0) {
    headers['In-Reply-To'] = ids[ids.length - 1] as string;
    headers.References = ids.join(' ');
  }

  const body = draft.body.replace(/\r\n?/g, '\n').trimEnd();
  const text = `${body}\n\n--\n${physical}\nTo stop receiving emails from me, unsubscribe here: ${unsubscribeUrl}\n`;
  return { headers, text };
}
