import { createHmac, timingSafeEqual } from 'node:crypto';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SIG_CHARS = 32; // 192 bits of the HMAC, plenty for a link that can only unsubscribe

function signature(leadId: string, secret: string): string {
  return createHmac('sha256', secret).update(`unsubscribe:${leadId}`).digest('base64url').slice(0, SIG_CHARS);
}

/** `<base64url lead uuid>.<hmac>`: URL safe, deterministic, and useless without the secret. */
export function signUnsubscribeToken(leadId: string, secret: string): string {
  if (!UUID_RE.test(leadId)) throw new Error('leadId must be a UUID');
  const id = leadId.toLowerCase();
  return `${Buffer.from(id.replace(/-/g, ''), 'hex').toString('base64url')}.${signature(id, secret)}`;
}

/** Returns the lead id for a genuine token, otherwise null. Never throws. */
export function verifyUnsubscribeToken(token: string, secret: string): string | null {
  if (typeof token !== 'string' || token.length > 100) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [idPart, sig] = parts as [string, string];
  const bytes = Buffer.from(idPart, 'base64url');
  if (bytes.length !== 16 || bytes.toString('base64url') !== idPart) return null;
  const hex = bytes.toString('hex');
  const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  const expected = Buffer.from(signature(id, secret));
  const provided = Buffer.from(sig);
  return provided.length === expected.length && timingSafeEqual(provided, expected) ? id : null;
}
