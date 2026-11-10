import { loadDefaults } from '../../workflows/src/lib/config.js';
import { fraction, notRun, type Case, type Ctx, type PartResult, type SuiteResult } from '../lib/types.js';
import { readJson } from '../lib/util.js';

interface Lead {
  email: string;
  country?: string;
  expected: { group: string; status?: string[]; reason?: string };
}
export interface RuleInput {
  suppressed: boolean;
  flags: string[];
  region_rule: string | null;
  has_mx: boolean;
}
export interface Verdict {
  status: string;
  reason: string;
}

/**
 * The deterministic checks of WF-02 in the order it applies them: suppression, address class, region, then MX.
 * It reproduces the order only; each input is read from the real rg-tools routes and database functions.
 */
export function ruleVerdict(i: RuleInput): Verdict | null {
  const h = loadDefaults().hygiene;
  if (i.suppressed) return { status: 'suppressed', reason: 'suppression_list' };
  if (i.flags.includes('disposable')) return { status: 'rejected', reason: 'disposable' };
  if (i.flags.includes('role') && !h.allow_role_based) return { status: 'rejected', reason: 'role_based' };
  if (i.flags.includes('free_provider') && !h.allow_free_providers) return { status: 'rejected', reason: 'free_provider' };
  if (i.region_rule === 'blocked') return { status: 'rejected', reason: 'region_blocked' };
  if (i.region_rule === 'restricted') return { status: 'needs_review', reason: 'region_restricted' };
  if (!i.has_mx) return { status: 'rejected', reason: 'no_mx' };
  return null;
}

const RULE_GROUPS = new Set(['no_mx', 'role_based', 'disposable', 'suppressed', 'region', 'free_provider']);

/** What the rule layer should say about a lead: a verdict for the planted bad groups, null (pass) for the rest. */
function expectedRule(l: Lead): Verdict | null {
  const g = l.expected.group;
  if (!RULE_GROUPS.has(g)) return null;
  if (g === 'suppressed') return { status: 'suppressed', reason: 'suppression_list' };
  if (g === 'region') return { status: l.expected.status![0]!, reason: l.expected.reason! };
  return { status: 'rejected', reason: l.expected.reason! };
}

const SCOPE = 'Rule layer only: the real rg-tools address and MX routes plus the database suppression and region rules, applied in WF-02 order. It does not run WF-02 itself.';

async function rulesPart(ctx: Ctx): Promise<PartResult> {
  if (!ctx.db) return notRun('rules', SCOPE, 'needs a database for the suppression list and region rules (set DATABASE_URL)');
  if (ctx.mode !== 'sandbox') return notRun('rules', SCOPE, `writes the sandbox suppression seed, so it only runs when rg-tools reports MODE=sandbox (got ${ctx.mode})`);
  const db = ctx.db;
  const leads = readJson<Lead[]>(ctx.root, 'sandbox/leads.seed.json').filter((l) => l.expected.group !== 'exact_duplicate');
  const seed = readJson<{ kind: string; value: string; reason: string }[]>(ctx.root, 'sandbox/suppression.seed.json');

  const inserted: string[] = [];
  for (const s of seed) {
    const r = await db.query("INSERT INTO suppression (kind, value, reason, source) VALUES ($1, $2::citext, $3, 'eval-seed') ON CONFLICT (kind, value) DO NOTHING RETURNING id", [s.kind, s.value, s.reason]);
    if (r.rows.length) inserted.push(s.value);
  }
  const cases: Case[] = [];
  try {
    for (const l of leads) {
      const email = l.email.trim().toLowerCase();
      const supp = (await db.query('SELECT is_suppressed($1::citext) AS s', [email])).rows[0]?.s === true;
      const cls = await ctx.api.post('/v1/hygiene/classify-email', { email });
      const mx = await ctx.api.post('/v1/hygiene/dns-mx', { domain: email.split('@')[1] });
      if (cls.status !== 200 || mx.status !== 200) throw new Error(`rg-tools answered ${cls.status}/${mx.status} for ${email}`);
      const region = l.country ? (await db.query('SELECT rule FROM region_rules WHERE country = upper($1)', [l.country])).rows[0]?.rule ?? null : null;
      const actual = ruleVerdict({ suppressed: supp, flags: cls.json.flags ?? [], region_rule: region, has_mx: mx.json.has_mx === true });
      const expected = expectedRule(l);
      cases.push({ id: email, passed: JSON.stringify(actual) === JSON.stringify(expected), expected, actual });
    }
  } finally {
    await db.query("DELETE FROM suppression WHERE source = 'eval-seed'");
  }
  const planted = cases.filter((c) => c.expected !== null);
  const clean = cases.filter((c) => c.expected === null);
  const caught = planted.filter((c) => c.passed).length;
  const blocked = clean.filter((c) => c.actual !== null).length;
  return {
    name: 'rules', scope: SCOPE, status: 'run',
    metrics: [
      { name: 'planted bad leads caught with the right reason', value: caught, display: fraction(caught, planted.length) },
      { name: 'clean leads blocked by the rules', value: blocked, display: fraction(blocked, clean.length) },
    ],
    cases,
  };
}

export async function runHygiene(ctx: Ctx): Promise<SuiteResult> {
  return {
    suite: 'hygiene',
    parts: [
      await rulesPart(ctx),
      notRun('pipeline', 'All 60 seed leads through WF-01 to WF-06 and the final status and reason compared with `expected`.', 'needs the running n8n stack (make demo) and, for research and scoring, an LLM key'),
    ],
  };
}
