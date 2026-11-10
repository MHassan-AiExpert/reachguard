import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { normalizeForMatch } from './grounding.js';
import { shingleHashes } from './shingles.js';

export interface CopyClaim {
  text: string;
  evidence_id: string;
}

export interface CopyStep {
  step: number;
  subject: string | null;
  body: string;
  claims: CopyClaim[];
}

export interface CopyOutput {
  variant_label: string;
  sequence: CopyStep[];
}

export interface QaRules {
  step1_words: [number, number];
  followup_words: [number, number];
  subject_max_chars: number;
  similarity_threshold: number;
  banned_phrases: string[];
}

export interface PrecheckContext {
  lead_id: string;
  evidenceIds: Set<string>;
  rules: QaRules;
}

export interface PrecheckResult {
  ok: boolean;
  violations: string[];
  shingle_hashes: string[];
}

export function loadQaRules(configDir: string): QaRules {
  const doc = parse(readFileSync(path.join(configDir, 'defaults.yaml'), 'utf8')) as {
    qa: Record<string, unknown>;
  };
  const q = doc.qa;
  return {
    step1_words: q.step1_words as [number, number],
    followup_words: q.followup_words as [number, number],
    subject_max_chars: q.subject_max_chars as number,
    similarity_threshold: q.similarity_threshold as number,
    banned_phrases: (q.banned_phrases as string[]).map((p) => p.toLowerCase()),
  };
}

const LINK_RE =
  /(https?:\/\/|www\.|mailto:)|\b[a-z0-9-]+(\.[a-z0-9-]+)*\.(com|net|org|io|co|ai|app|dev|xyz|info|biz|me|us|uk|de|pk|ly|gg|tv)\b/i;
const EMOJI_RE = /\p{Extended_Pictographic}/u;
const FAKE_PREFIX_RE = /^\s*(re|fwd?|fw)\s*:/i;

const wordCount = (body: string): number => body.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
const norm = (s: string): string => normalizeForMatch(s).toLowerCase();

export function precheckCopy(copy: CopyOutput, ctx: PrecheckContext): PrecheckResult {
  const v: string[] = [];
  const owned = new Set([...ctx.evidenceIds].map((id) => id.toLowerCase()));
  const phrases = ctx.rules.banned_phrases.map(norm).filter(Boolean);
  const sequence = copy.sequence ?? [];
  if (sequence.length === 0) v.push('sequence_empty');

  sequence.forEach((s, i) => {
    const n = i + 1;
    const label = `step${n}`;
    const first = i === 0;
    const body = s.body ?? '';
    const subject = s.subject ?? null;

    if (s.step !== n) v.push(`${label}:sequence_order:expected step ${n}, got ${s.step}`);

    const words = wordCount(body);
    const [min, max] = first ? ctx.rules.step1_words : ctx.rules.followup_words;
    if (words < min) v.push(`${label}:words_too_few:${words}<${min}`);
    if (words > max) v.push(`${label}:words_too_many:${words}>${max}`);

    if (first) {
      if (subject === null || subject.trim() === '') v.push(`${label}:subject_missing`);
    } else if (subject !== null) {
      v.push(`${label}:subject_not_null`);
    }
    if (subject !== null && subject.length > ctx.rules.subject_max_chars) {
      v.push(`${label}:subject_too_long:${subject.length}>${ctx.rules.subject_max_chars}`);
    }
    if (subject !== null && FAKE_PREFIX_RE.test(subject)) v.push(`${label}:fake_reply_prefix`);

    if (first) {
      if (LINK_RE.test(body)) v.push(`${label}:link_in_first_email`);
      if (EMOJI_RE.test(body) || EMOJI_RE.test(subject ?? '')) v.push(`${label}:emoji_in_first_email`);
      const questions = (body.match(/\?/g) ?? []).length;
      if (questions !== 1) v.push(`${label}:cta_question_count:${questions}`);
    }

    const haystack = norm(`${subject ?? ''}\n${body}`);
    for (const p of phrases) if (haystack.includes(p)) v.push(`${label}:banned_phrase:${p}`);

    for (const claim of s.claims ?? []) {
      if (!owned.has(String(claim.evidence_id).toLowerCase())) {
        v.push(`${label}:claim_evidence_not_owned:${claim.evidence_id}`);
      }
    }
  });

  return { ok: v.length === 0, violations: v, shingle_hashes: shingleHashes(sequence[0]?.body ?? '') };
}
