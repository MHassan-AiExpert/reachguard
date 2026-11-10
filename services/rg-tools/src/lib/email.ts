import { readFileSync } from 'node:fs';
import path from 'node:path';
import { domainToASCII } from 'node:url';

export type EmailFlag = 'role' | 'disposable' | 'free_provider';

export interface HygieneLists {
  disposable: Set<string>;
  role: Set<string>;
  free: Set<string>;
}

export interface EmailClassification {
  input: string;
  normalized: string;
  dedupe_key: string;
  syntax_ok: boolean;
  domain: string;
  flags: EmailFlag[];
}

function readList(file: string): Set<string> {
  const out = new Set<string>();
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const v = line.trim().toLowerCase();
    if (v && !v.startsWith('#')) out.add(v);
  }
  return out;
}

export function loadHygieneLists(configDir: string): HygieneLists {
  return {
    disposable: readList(path.join(configDir, 'disposable-domains.txt')),
    role: readList(path.join(configDir, 'role-accounts.txt')),
    free: readList(path.join(configDir, 'free-providers.txt')),
  };
}

// RFC 5322 atext, ASCII only (no quoted strings or comments: they are not worth the risk in outreach).
const LOCAL_RE = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const LABEL_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

function domainOk(domain: string): boolean {
  if (domain.length === 0 || domain.length > 253) return false;
  const labels = domain.split('.');
  if (labels.length < 2) return false;
  if (!labels.every((l) => l.length >= 1 && l.length <= 63 && LABEL_RE.test(l))) return false;
  const tld = labels[labels.length - 1] as string;
  return tld.startsWith('xn--') || /^[a-z]{2,}$/.test(tld);
}

function baseLocal(local: string): string {
  const i = local.indexOf('+');
  return i === -1 ? local : local.slice(0, i);
}

function onList(domain: string, set: Set<string>): boolean {
  const parts = domain.split('.');
  for (let i = 0; i < parts.length - 1; i++) {
    if (set.has(parts.slice(i).join('.'))) return true;
  }
  return false;
}

export function classifyEmail(raw: string, lists: HygieneLists): EmailClassification {
  const input = typeof raw === 'string' ? raw : '';
  const trimmed = input.trim().toLowerCase();
  const fail = (): EmailClassification => ({
    input,
    normalized: trimmed,
    dedupe_key: trimmed,
    syntax_ok: false,
    domain: '',
    flags: [],
  });

  const at = trimmed.indexOf('@');
  if (at < 1 || at !== trimmed.lastIndexOf('@')) return fail();
  const local = trimmed.slice(0, at);
  const rawDomain = trimmed.slice(at + 1);
  if (local.length > 64 || !LOCAL_RE.test(local)) return fail();
  const domain = domainToASCII(rawDomain);
  if (!domain || !domainOk(domain) || local.length + 1 + domain.length > 254) return fail();

  const base = baseLocal(local);
  const flags: EmailFlag[] = [];
  if (lists.role.has(base)) flags.push('role');
  if (onList(domain, lists.disposable)) flags.push('disposable');
  if (lists.free.has(domain)) flags.push('free_provider');

  return {
    input,
    normalized: `${local}@${domain}`,
    dedupe_key: `${base}@${domain}`,
    syntax_ok: true,
    domain,
    flags,
  };
}
