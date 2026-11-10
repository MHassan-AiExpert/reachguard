import { createHmac, timingSafeEqual } from 'node:crypto';

export const MAX_SKEW_SECONDS = 300;

/**
 * Verifies an HMAC-SHA256 webhook signature computed over `${timestamp}.${rawBody}`.
 * Rejects empty bodies, malformed input, and timestamps more than 5 minutes from `now` in either direction.
 */
export function verifyWebhook(
  secret: string,
  rawBody: string,
  signature: string,
  timestamp: string,
  now: Date = new Date(),
): boolean {
  if (!rawBody || !signature || !/^\d{1,12}$/.test(timestamp)) return false;
  const skew = Math.abs(now.getTime() / 1000 - Number(timestamp));
  if (skew > MAX_SKEW_SECONDS) return false;

  const provided = signature.startsWith('sha256=') ? signature.slice(7) : signature;
  if (!/^[0-9a-fA-F]{64}$/.test(provided)) return false;

  const expected = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest();
  return timingSafeEqual(Buffer.from(provided, 'hex'), expected);
}
