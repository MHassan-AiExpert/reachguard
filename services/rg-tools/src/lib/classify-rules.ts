import { readFileSync } from 'node:fs';
import path from 'node:path';
import { normalizeForMatch } from './grounding.js';

export interface UnsubscribeRules {
  exact: Set<string>;
  phrases: string[];
}

/** Lower case, diacritics and apostrophes removed, everything else that is not a letter or digit becomes a space. */
export function normalizeForRules(s: string): string {
  return normalizeForMatch(s)
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/'/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export function loadUnsubscribeRules(configDir: string): UnsubscribeRules {
  const doc = JSON.parse(readFileSync(path.join(configDir, 'unsubscribe-keywords.json'), 'utf8')) as {
    exact: string[];
    phrases: string[];
  };
  return { exact: new Set(doc.exact.map(normalizeForRules)), phrases: doc.phrases.map(normalizeForRules) };
}

const QUOTE_INTRO = [
  /^on .{5,300} wrote:?$/,
  /^(el|le|am|em|il) .{5,300}(escribio|a ecrit|schrieb|escreveu|ha scritto):?$/,
  /^-{2,}\s*(original message|forwarded message|mensaje original|message dorigine|ursprungliche nachricht)/,
];

/** Drops quoted lines and everything after a "wrote:" or "original message" marker, so our own footer is not read as a request. */
function stripQuoted(body: string): string {
  const lines = body.split(/\r?\n/);
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] as string).trim();
    if (line.startsWith('>')) continue;
    if (line.length < 400) {
      const flat = normalizeForMatch(line).toLowerCase();
      const joined =
        i + 1 < lines.length
          ? `${flat} ${normalizeForMatch(lines[i + 1] as string).toLowerCase()}`.trim()
          : flat;
      if (QUOTE_INTRO.some((re) => re.test(flat) || re.test(joined))) break;
    }
    kept.push(line);
  }
  return kept.join('\n');
}

/** True when the reply asks to stop contact, in any supported language, even inside an otherwise positive message. */
export function applyUnsubscribeRules(body: string, rules: UnsubscribeRules): boolean {
  if (!body) return false;
  const text = normalizeForRules(stripQuoted(body));
  if (!text) return false;
  if (rules.exact.has(text)) return true;
  const padded = ` ${text} `;
  return rules.phrases.some((p) => padded.includes(` ${p} `));
}
