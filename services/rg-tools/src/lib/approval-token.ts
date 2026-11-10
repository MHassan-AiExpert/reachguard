import { createHmac, timingSafeEqual } from 'node:crypto';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTIONS = { approve: 'a', edit: 'e', reject: 'r' } as const;
export type ApprovalAction = keyof typeof ACTIONS;
const CODE_TO_ACTION = Object.fromEntries(Object.entries(ACTIONS).map(([k, v]) => [v, k])) as Record<string, ApprovalAction>;
// Telegram caps callback_data at 64 bytes: 36 (uuid) + 2 separators + 1 (action) leaves 25; 20 chars is 120 bits.
const SIG_CHARS = 20;

function sig(approvalId: string, code: string, secret: string): string {
  return createHmac('sha256', secret).update(`approval:${approvalId}:${code}`).digest('base64url').slice(0, SIG_CHARS);
}

/** `<approval uuid>:<a|e|r>:<hmac>` for a Telegram inline button. */
export function signApprovalCallback(approvalId: string, action: ApprovalAction, secret: string): string {
  if (!UUID_RE.test(approvalId)) throw new Error('approvalId must be a UUID');
  const id = approvalId.toLowerCase();
  const code = ACTIONS[action];
  return `${id}:${code}:${sig(id, code, secret)}`;
}

/** Returns the approval and action for genuine callback data, otherwise null. Never throws. */
export function verifyApprovalCallback(data: string, secret: string): { approval_id: string; action: ApprovalAction } | null {
  if (typeof data !== 'string' || data.length > 100) return null;
  const parts = data.split(':');
  if (parts.length !== 3) return null;
  const [id, code, provided] = parts as [string, string, string];
  if (!UUID_RE.test(id) || !(code in CODE_TO_ACTION)) return null;
  const expected = Buffer.from(sig(id.toLowerCase(), code, secret));
  const got = Buffer.from(provided);
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) return null;
  return { approval_id: id.toLowerCase(), action: CODE_TO_ACTION[code] as ApprovalAction };
}
