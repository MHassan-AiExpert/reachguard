#!/usr/bin/env node
// Checks the sandbox data against SPEC §11: group counts, fictional domains only, fixture sites for every website,
// the labeled reply mix and the suppression seed. Runs in CI. Exits 1 and lists every problem it finds.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sbx = path.join(root, 'sandbox');
const errors = [];
const fail = (m) => errors.push(m);
const read = (f) => JSON.parse(readFileSync(path.join(sbx, f), 'utf8'));
const lines = (f) =>
  new Set(readFileSync(path.join(root, 'config', f), 'utf8').split('\n').map((l) => l.trim().toLowerCase()).filter((l) => l && !l.startsWith('#')));

const GROUPS = {
  ideal_fit: 10, exact_duplicate: 6, near_duplicate_company: 4, no_mx: 5, role_based: 5, disposable: 4,
  catch_all: 4, suppressed: 3, eu_uk: 3, region: 3, free_provider: 3, weak_icp: 4, injection_site: 3, thin_site: 3,
};
const CLASSES = { interested: 10, objection: 6, not_now: 6, unsubscribe: 5, out_of_office: 4, wrong_person: 3, bounce: 3, other: 3 };
const FICTIONAL = /\.(example|test)$/i;
const norm = (e) => String(e).trim().toLowerCase();
const domainOf = (e) => norm(e).split('@')[1] ?? '';
const hostOf = (w) => new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(w) ? w : `https://${w}`).hostname.replace(/^www\./, '');
const slugOf = (w) => hostOf(w).split('.')[0];
const words = (html) => html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').split(/\s+/).filter(Boolean).length;

function sitePages(slug) {
  const dir = path.join(sbx, 'sites', slug);
  if (!existsSync(dir)) return null;
  return Object.fromEntries(readdirSync(dir).filter((f) => f.endsWith('.html')).map((f) => [f.replace(/\.html$/, ''), readFileSync(path.join(dir, f), 'utf8')]));
}

let leads = [];
try {
  leads = read('leads.seed.json');
} catch (e) {
  fail(`sandbox/leads.seed.json: ${e.message}`);
}
let replies = [];
try {
  replies = read('replies.labeled.json');
} catch (e) {
  fail(`sandbox/replies.labeled.json: ${e.message}`);
}
let suppression = [];
try {
  suppression = read('suppression.seed.json');
} catch (e) {
  fail(`sandbox/suppression.seed.json: ${e.message}`);
}

// Leads
if (leads.length !== 60) fail(`expected 60 leads, found ${leads.length}`);
const counts = {};
for (const l of leads) counts[l.expected?.group] = (counts[l.expected?.group] ?? 0) + 1;
for (const [g, n] of Object.entries(GROUPS)) if ((counts[g] ?? 0) !== n) fail(`group ${g}: expected ${n}, found ${counts[g] ?? 0}`);
for (const g of Object.keys(counts)) if (!(g in GROUPS)) fail(`unknown group ${g}`);

const disposable = lines('disposable-domains.txt');
const free = lines('free-providers.txt');
const seen = new Map();
leads.forEach((l, i) => {
  const at = `lead ${i} (${l.email})`;
  for (const k of ['campaign', 'email', 'company', 'expected']) if (!l[k]) fail(`${at}: missing ${k}`);
  if (l.campaign !== 'demo-ai-automation') fail(`${at}: campaign must be demo-ai-automation`);
  const e = l.expected ?? {};
  if (!e.outcome) fail(`${at}: expected.outcome missing`);
  const d = domainOf(l.email);
  const allowedReal = (e.group === 'disposable' && disposable.has(d)) || (e.group === 'free_provider' && free.has(d));
  if (!FICTIONAL.test(d) && !allowedReal) fail(`${at}: domain ${d} is not reserved or fictional`);
  if (l.website && !FICTIONAL.test(hostOf(l.website))) fail(`${at}: website ${l.website} is not reserved or fictional`);
  const k = norm(l.email);
  if (e.group === 'exact_duplicate') {
    if (!seen.has(k)) fail(`${at}: exact_duplicate must repeat an earlier lead`);
  } else if (seen.has(k)) fail(`${at}: email repeated outside the exact_duplicate group`);
  if (!seen.has(k)) seen.set(k, i);
  if (e.group === 'no_mx' && !d.startsWith('nomx-')) fail(`${at}: no_mx domains must start with nomx-`);
  if (e.group === 'role_based' && !lines('role-accounts.txt').has(norm(l.email).split('@')[0])) fail(`${at}: local part is not a listed role account`);
  if (e.group === 'catch_all' && !(l.tags ?? []).includes('catch_all')) fail(`${at}: catch_all lead needs the catch_all tag`);
});

// Fixture sites
const slugs = new Set();
for (const l of leads) if (l.website) slugs.add(slugOf(l.website));
for (const s of slugs) if (!sitePages(s)?.index) fail(`fixture site ${s}: sandbox/sites/${s}/index.html missing`);
const onDisk = existsSync(path.join(sbx, 'sites')) ? readdirSync(path.join(sbx, 'sites')) : [];
for (const s of onDisk) if (!slugs.has(s)) fail(`fixture site ${s} is not referenced by any lead`);
for (const s of slugs) {
  for (const [page, html] of Object.entries(sitePages(s) ?? {})) {
    if (!/fictional/i.test(html)) fail(`fixture ${s}/${page}.html does not say it is fictional`);
  }
}
for (const l of leads.filter((x) => x.expected?.group === 'ideal_fit')) {
  const p = sitePages(slugOf(l.website ?? '')) ?? {};
  for (const page of ['index', 'about', 'news', 'blog']) if (!p[page]) fail(`rich site ${slugOf(l.website ?? '')} lacks ${page}.html`);
}
for (const l of leads.filter((x) => x.expected?.group === 'thin_site')) {
  const p = sitePages(slugOf(l.website ?? '')) ?? {};
  const total = Object.values(p).reduce((n, h) => n + words(h), 0);
  if (total > 90) fail(`thin site ${slugOf(l.website ?? '')} has ${total} words, must stay under 90`);
}
const inj = leads.filter((x) => x.expected?.group === 'injection_site');
for (const l of inj) {
  const planted = l.expected.planted_strings ?? [];
  if (planted.length === 0) fail(`injection lead ${l.email}: expected.planted_strings missing`);
  const html = Object.values(sitePages(slugOf(l.website ?? '')) ?? {}).join('\n');
  for (const s of planted) if (!html.includes(s)) fail(`injection site ${slugOf(l.website ?? '')} does not contain planted string "${s}"`);
}

// Suppression seed
const byKind = Object.fromEntries(suppression.map((s) => [s.kind, s]));
for (const k of ['email', 'domain', 'email_hash']) if (!byKind[k]) fail(`suppression seed lacks kind ${k}`);
if (suppression.length !== 3) fail(`expected 3 suppression entries, found ${suppression.length}`);
for (const l of leads.filter((x) => x.expected?.group === 'suppressed')) {
  const em = norm(l.email);
  const hit =
    suppression.some((s) => s.kind === 'email' && s.value.toLowerCase() === em) ||
    suppression.some((s) => s.kind === 'domain' && s.value.toLowerCase() === domainOf(em)) ||
    suppression.some((s) => s.kind === 'email_hash' && s.value === createHash('sha256').update(em).digest('hex'));
  if (!hit) fail(`suppressed lead ${l.email} matches no suppression entry`);
}
for (const l of leads.filter((x) => x.expected?.group !== 'suppressed')) {
  const em = norm(l.email);
  if (suppression.some((s) => (s.kind === 'email' && s.value.toLowerCase() === em) || (s.kind === 'domain' && s.value.toLowerCase() === domainOf(em)))) {
    fail(`lead ${l.email} is suppressed by the seed but is not in the suppressed group`);
  }
}

// Replies
if (replies.length !== 40) fail(`expected 40 replies, found ${replies.length}`);
const rc = {};
for (const r of replies) rc[r.expected_classification] = (rc[r.expected_classification] ?? 0) + 1;
for (const [c, n] of Object.entries(CLASSES)) if ((rc[c] ?? 0) !== n) fail(`reply class ${c}: expected ${n}, found ${rc[c] ?? 0}`);
const deliverable = new Set(leads.filter((l) => ['ideal_fit', 'catch_all', 'eu_uk'].includes(l.expected?.group)).map((l) => norm(l.email)));
replies.forEach((r, i) => {
  const at = `reply ${i}`;
  if (typeof r.body !== 'string' || r.body.trim() === '') fail(`${at}: empty body`);
  if (typeof r.unsubscribe_intent !== 'boolean') fail(`${at}: unsubscribe_intent must be boolean`);
  if (!deliverable.has(norm(r.email ?? ''))) fail(`${at}: email ${r.email} is not a lead that gets emailed`);
  if (r.expected_classification === 'unsubscribe' && r.unsubscribe_intent !== true) fail(`${at}: unsubscribe reply must have unsubscribe_intent true`);
  for (const m of String(r.body).match(/[\w.+-]+@[\w.-]+/g) ?? []) if (!FICTIONAL.test(domainOf(m))) fail(`${at}: address ${m} is not fictional`);
});
const tagged = (t) => replies.some((r) => (r.tags ?? []).includes(t));
for (const t of ['blunt', 'polite', 'spanish', 'hidden', 'referral']) if (!tagged(t)) fail(`no reply tagged ${t}`);
if (replies.filter((r) => r.unsubscribe_intent).length < 5) fail('fewer than 5 replies carry unsubscribe_intent');

if (errors.length) {
  console.error(`sandbox validation failed (${errors.length}):\n- ${errors.join('\n- ')}`);
  process.exit(1);
}
console.log(`sandbox ok: ${leads.length} leads, ${slugs.size} fixture sites, ${replies.length} replies, ${suppression.length} suppression entries`);
