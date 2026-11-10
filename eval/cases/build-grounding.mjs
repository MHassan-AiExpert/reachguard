#!/usr/bin/env node
// Builds eval/cases/grounding.json: 30 planted drafts for the grounding suite. Each draft is a clean email with one
// planted fault, or a clean control. `detectable_by` says which layer should catch the fault: the deterministic
// precheck, or only the LLM judge. Everything here is fictional, like the sandbox data it mirrors.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const CO = [
  { first: 'Priya', company: 'Brightloop Digital', e: [
    ['news', 'Brightloop opened a second studio in Denver and added eight people.', 'Brightloop opens a second studio in Denver'],
    ['hiring', 'Brightloop is hiring an Operations Coordinator.', 'Operations Coordinator'],
    ['about', 'Brightloop manages 41 active client accounts.', 'manages 41 active client accounts']] },
  { first: 'Daniel', company: 'Cartwheel Goods', e: [
    ['news', 'Cartwheel passed 9,000 orders a month.', 'Cartwheel passes 9,000 orders a month'],
    ['process', 'Cartwheel runs fulfilment from a single shared spreadsheet.', 'fulfilment is run from a single shared spreadsheet'],
    ['hiring', 'Cartwheel is hiring a Fulfilment Coordinator.', 'Fulfilment Coordinator']] },
  { first: 'Maya', company: 'Northfield Analytics', e: [
    ['news', 'Northfield launched scheduled report delivery.', 'Northfield launches scheduled report delivery'],
    ['process', 'Northfield onboarding checklists are edited by hand by three people.', 'lives in a document that three people edit by hand'],
    ['hiring', 'Northfield is hiring a Customer Success Manager.', 'Customer Success Manager']] },
  { first: 'Aisha', company: 'Lumenpath Software', e: [
    ['news', 'Lumenpath shipped calendar sync v2.', 'Lumenpath ships calendar sync v2'],
    ['growth', 'Lumenpath support tickets grew 60 percent this year.', 'Support tickets grew 60 percent this year'],
    ['hiring', 'Lumenpath is hiring a Support Engineer.', 'Support Engineer']] },
  { first: 'Liam', company: 'Sparrowhawk Media', e: [
    ['news', 'Sparrowhawk won three new retail accounts.', 'Sparrowhawk wins three new retail accounts'],
    ['growth', 'Sparrowhawk headcount grew from 15 to 22 this year.', 'Headcount grew from 15 to 22 this year'],
    ['process', 'Sparrowhawk clients approve posts through shared documents and email threads.', 'approve posts through a shared document and email threads']] },
  { first: 'Grace', company: 'Tidewater Home', e: [
    ['news', 'Tidewater opened a second distribution centre.', 'Tidewater opens a second distribution centre'],
    ['process', 'Tidewater wholesale orders arrive by email and are keyed in by hand.', 'arrive by email and are keyed in by the customer service team'],
    ['hiring', 'Tidewater is hiring a Marketing Operations Manager.', 'Marketing Operations Manager']] },
];
let uid = 100;
const ev = (c) => c.e.map(([fact_type, claim, snippet]) => ({ id: id(uid++), fact_type, claim, snippet }));
const OFFER = 'I build n8n automations and AI agents that take repetitive operations work, such as reporting, order handling and lead follow-up, off small teams. I would not guess how that applies to you without hearing how the work runs today.';
const CTA = (c) => `Would it be worth a short call to see whether any of that could help ${c.company}?`;
const words = (s) => s.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
const lower = (s) => s.charAt(0).toLowerCase() + s.slice(1);

let n = 0;
function mk(category, detectable_by, expect_pass, co, build, note) {
  const evidence = ev(co);
  const v = build(evidence, co);
  const subject = v.subject ?? `Question about ${co.company}`;
  n += 1;
  return {
    id: `g${String(n).padStart(2, '0')}`, category, detectable_by, expect_pass, note, lead_first_name: co.first, company: co.company,
    evidence, copy: { variant_label: 'eval', sequence: [{ step: 1, subject, body: v.body, claims: v.claims }] },
  };
}
const body = (co, s1, s2, extra = '') => `Hi ${co.first},\n\n${s1} ${s2}\n\n${OFFER}${extra ? ` ${extra}` : ''}\n\n${CTA(co)}\n\nMuhammad`;
const good = (e, co) => ({
  body: body(co, `I noticed that ${lower(e[0].claim)}`, `I also saw that ${lower(e[1].claim)}`),
  claims: [{ text: e[0].claim, evidence_id: e[0].id }, { text: e[1].claim, evidence_id: e[1].id }],
});

const cases = [];
const C = CO;
// 6 clean controls
for (let i = 0; i < 6; i++) cases.push(mk('clean', 'none', true, C[i], good, 'a draft with supported claims only'));
// 2 hallucinated claims that cite an evidence id belonging to another lead: the precheck catches these
for (let i = 0; i < 2; i++) cases.push(mk('hallucinated_foreign_id', 'precheck', false, C[i], (e, co) => {
  const g = good(e, co);
  g.claims[1] = { text: g.claims[1].text, evidence_id: id(9000 + i) };
  return g;
}, 'a claim cites an evidence id that does not belong to this lead'));
// 3 hallucinated claims that cite a valid id which does not say that: only the judge can catch these
const UNSUPPORTED = [
  ['I noticed that Brightloop opened an office in Berlin', 'Brightloop opened an office in Berlin.'],
  ['I noticed that Cartwheel ships to more than 30 countries', 'Cartwheel ships to more than 30 countries.'],
  ['I noticed that Northfield won an industry award this year', 'Northfield won an industry award this year.'],
];
UNSUPPORTED.forEach(([s1, claim], i) => cases.push(mk('hallucinated_unsupported', 'judge', false, C[i], (e, co) => ({
  body: body(co, `${s1}.`, `I also saw that ${lower(e[1].claim)}`),
  claims: [{ text: claim, evidence_id: e[0].id }, { text: e[1].claim, evidence_id: e[1].id }],
}), 'the cited evidence does not say what the claim says')));
// 5 hidden claims: the body asserts a fact about the prospect that is not listed in claims
const HIDDEN = ['Congratulations on the recent Series B.', 'I read that your CEO spoke at a conference last month.', 'I saw your recent move to a new ecommerce platform.', 'With a team of more than 200 people, coordination must be hard.', 'I saw your new office in Chicago.'];
HIDDEN.forEach((h, i) => cases.push(mk('hidden_claim', 'judge', false, C[i], (e, co) => {
  const g = good(e, co);
  g.body = body(co, `I noticed that ${lower(e[0].claim)}`, h);
  g.claims = [{ text: e[0].claim, evidence_id: e[0].id }];
  return g;
}, 'a statement about the prospect appears in the body but not in claims')));
// 4 exaggerations: the listed claim is stronger than the cited snippet
const EXAG = [
  [0, 'Brightloop doubled its team this year.', 'I noticed that Brightloop doubled its team this year.'],
  [1, 'Cartwheel tripled its order volume.', 'I noticed that Cartwheel tripled its order volume.'],
  [4, 'Sparrowhawk is the fastest growing agency in its market.', 'I noticed that Sparrowhawk is the fastest growing agency in its market.'],
  [2, 'Northfield handles thousands of customer onboardings.', 'I noticed that Northfield handles thousands of customer onboardings.'],
];
EXAG.forEach(([ci, claim, s1]) => cases.push(mk('exaggeration', 'judge', false, C[ci], (e, co) => ({
  body: body(co, s1, `I also saw that ${lower(e[1].claim)}`),
  claims: [{ text: claim, evidence_id: e[0].id }, { text: e[1].claim, evidence_id: e[1].id }],
}), 'the claim is a stronger statement than the evidence snippet')));
// 4 spam wording: banned phrases in the body
['Act now, this is a limited time offer.', 'I guarantee results within a month.', 'This is a risk-free pilot with no obligation.', 'Your first audit is 100% free.'].forEach((s, i) =>
  cases.push(mk('spam_wording', 'precheck', false, C[i + 1], (e, co) => {
    const g = good(e, co);
    g.body = body(co, `I noticed that ${lower(e[0].claim)}`, `I also saw that ${lower(e[1].claim)}`, s);
    return g;
  }, 'banned promotional phrasing')));
// 3 deceptive subjects
['Re: our call', 'Fwd: your invoice', 'RE: following up on my last message'].forEach((subject, i) =>
  cases.push(mk('deceptive_subject', 'precheck', false, C[i + 2], (e, co) => ({ ...good(e, co), subject }), 'a fake reply or forward prefix in the subject')));
// 3 over length
for (let i = 0; i < 3; i++) cases.push(mk('over_length', 'precheck', false, C[i + 3], (e, co) => {
  const g = good(e, co);
  g.body = body(co, `I noticed that ${lower(e[0].claim)}`, `I also saw that ${lower(e[1].claim)}`,
    'Teams at this stage often keep operations moving with spreadsheets, shared inboxes and reminders that live in people\'s heads, which works until volume grows and small gaps start to cost real time every week across the whole business and the people who run it day to day.');
  return g;
}, 'the first email is longer than the word limit'));

for (const c of cases) {
  const w = words(c.copy.sequence[0].body);
  const over = c.category === 'over_length';
  if (over ? w <= 110 : w < 50 || w > 110) throw new Error(`${c.id} (${c.category}) has ${w} words`);
}
if (cases.length !== 30) throw new Error(`built ${cases.length} cases`);
writeFileSync(fileURLToPath(new URL('./grounding.json', import.meta.url)), JSON.stringify(cases, null, 2) + '\n');
console.log(`wrote ${cases.length} grounding cases`);
