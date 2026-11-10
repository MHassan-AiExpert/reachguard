export interface NormalizeInput {
  first_name?: string;
  last_name?: string;
  company_raw: string;
}

export interface NormalizeResult {
  first_name: string;
  last_name: string;
  company_clean: string;
  confidence: number;
}

const COMPANY_SUFFIXES = new Set([
  'inc',
  'incorporated',
  'llc',
  'llp',
  'lp',
  'ltd',
  'limited',
  'gmbh',
  'ag',
  'corp',
  'corporation',
  'co',
  'company',
  'plc',
  'sa',
  'srl',
  'bv',
  'nv',
  'pty',
  'pvt',
  'sarl',
  'oy',
  'ab',
  'as',
]);

const collapse = (s: string): string => s.replace(/\s+/g, ' ').trim();

function capitalizeToken(token: string): string {
  const lower = token.toLowerCase();
  const first = lower.charAt(0).toUpperCase() + lower.slice(1);
  if (/^mc[a-z]{2,}/.test(lower)) return 'Mc' + lower.charAt(2).toUpperCase() + lower.slice(3);
  return first;
}

function titleCasePerson(word: string): string {
  return word
    .split(' ')
    .map((w) =>
      w
        .split(/([-'’])/)
        .map((p) => (/^[-'’]$/.test(p) || p === '' ? p : capitalizeToken(p)))
        .join(''),
    )
    .join(' ');
}

function fixPersonName(raw: string | undefined): string {
  const s = collapse(raw ?? '');
  if (!s) return '';
  const isLower = s === s.toLowerCase();
  const isUpper = s === s.toUpperCase();
  return isLower || isUpper ? titleCasePerson(s) : s;
}

function stripSuffixes(name: string): string {
  const words = name.split(' ');
  while (words.length > 1) {
    const last = (words[words.length - 1] as string).replace(/[.,]/g, '').toLowerCase();
    if (!COMPANY_SUFFIXES.has(last)) break;
    words.pop();
    const prev = words[words.length - 1] as string;
    words[words.length - 1] = prev.replace(/[,\s]+$/, '');
  }
  return words.join(' ');
}

function fixCompanyCase(name: string): { value: string; changed: boolean } {
  const letters = name.replace(/[^A-Za-z]/g, '');
  if (!letters || name !== name.toUpperCase()) return { value: name, changed: false };
  let changed = false;
  const value = name
    .split(' ')
    .map((w) => {
      const alpha = w.replace(/[^A-Za-z]/g, '');
      if (alpha.length < 4) return w;
      changed = true;
      return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
    })
    .join(' ');
  return { value, changed };
}

const SUSPECT_RE = /https?:|www\.|@/i;
const WEIRD_CHARS_RE = /[^\p{L}\p{N} &.,'’\-/()]/u;

export function normalizeNames(input: NormalizeInput): NormalizeResult {
  const first_name = fixPersonName(input.first_name);
  const last_name = fixPersonName(input.last_name);
  const original = collapse(input.company_raw ?? '');
  if (!original) return { first_name, last_name, company_clean: '', confidence: 0 };

  if (SUSPECT_RE.test(original) || WEIRD_CHARS_RE.test(original)) {
    return { first_name, last_name, company_clean: original, confidence: 0.3 };
  }

  const stripped = stripSuffixes(original).replace(/[,.\s]+$/, '');
  const onlySuffix =
    stripped.split(' ').length === 1 && COMPANY_SUFFIXES.has(stripped.replace(/[.,]/g, '').toLowerCase());
  if (!stripped || onlySuffix) {
    return { first_name, last_name, company_clean: original, confidence: 0.3 };
  }

  const cased = fixCompanyCase(stripped);
  return { first_name, last_name, company_clean: cased.value, confidence: cased.changed ? 0.9 : 0.95 };
}
