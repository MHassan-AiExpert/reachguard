import { createHash } from 'node:crypto';

const WINDOW = 5;

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}']+/gu, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

/** Distinct 5-word windows. Texts shorter than a window yield a single shingle so identical short texts still match. */
export function shingles(text: string): string[] {
  const t = tokens(text);
  if (t.length === 0) return [];
  if (t.length < WINDOW) return [t.join(' ')];
  const out = new Set<string>();
  for (let i = 0; i + WINDOW <= t.length; i++) out.add(t.slice(i, i + WINDOW).join(' '));
  return [...out];
}

/** Stable 53-bit hash (fits a JS safe integer and a Postgres bigint), as a decimal string. */
export function hashShingle(shingle: string): string {
  const hex = createHash('sha256').update(shingle).digest('hex').slice(0, 14); // 56 bits
  return (BigInt(`0x${hex}`) >> 3n).toString();
}

export function shingleHashes(text: string): string[] {
  return [...new Set(shingles(text).map(hashShingle))];
}

export function jaccard(a: string[], b: string[]): number {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size === 0 && sb.size === 0) return 0;
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter++;
  return inter / (sa.size + sb.size - inter);
}
