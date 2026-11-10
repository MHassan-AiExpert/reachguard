import { describe, expect, it } from 'vitest';
import { buildWf02 } from '../src/wf-02-hygiene.js';
import { buildWf03 } from '../src/wf-03-research.js';
import { buildWf04 } from '../src/wf-04-scoring.js';
import type { N8nWorkflow } from '../src/lib/workflow.js';

const pos = (w: N8nWorkflow, name: string): number => w.nodes.findIndex((n) => n.name === name);
const text = (w: N8nWorkflow) => JSON.stringify(w);
const paths = (w: N8nWorkflow, name: string) => w.nodes.find((n) => n.name === name)!.parameters as { url?: string };

/** Names of nodes reachable from `from` following any output. */
function reach(w: N8nWorkflow, from: string): Set<string> {
  const seen = new Set<string>();
  const stack = [from];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const outs of w.connections[cur]?.main ?? []) for (const t of outs) if (!seen.has(t.node)) { seen.add(t.node); stack.push(t.node); }
  }
  return seen;
}

describe('WF-02 hygiene', () => {
  const w = buildWf02();
  it('claims received leads and is named WF-02', () => {
    expect(w.name).toMatch(/^WF-02 /);
    expect(text(w)).toContain("claim_leads('received'");
  });
  it('counts every lead already past hygiene towards the company contact cap, not only those already queued', () => {
    const q = (w.nodes.find((n) => n.name === 'H7 Company limits')!.parameters as { query: string }).query;
    for (const st of ['verified', 'researched', 'scored', 'drafted', 'qa_passed', 'pending_approval', 'approved', 'queued']) expect(q).toContain(`'${st}'`);
    expect(q).not.toContain("'received'");
  });
  it('runs H1..H10 in spec order: syntax, suppression, flags, region, normalize, company, limits, DNS, verifier', () => {
    const order = ['H1 Classify email', 'H2 Suppression', 'H4 Region rule', 'H5 Normalize', 'H6 Resolve company', 'H7 Company limits', 'H8 DNS MX', 'H9 Verify primary'];
    const idx = order.map((n) => pos(w, n));
    expect(idx.every((i) => i >= 0)).toBe(true);
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
  });
  it('places the DNS check before any verifier call', () => {
    expect(pos(w, 'H8 DNS MX')).toBeLessThan(pos(w, 'H9 Verify primary'));
    expect(paths(w, 'H8 DNS MX').url).toContain('/v1/hygiene/dns-mx');
    expect(paths(w, 'H9 Verify primary').url).toContain('/v1/verify');
  });
  it('reaches the escalation verifier only from the primary verifier', () => {
    expect(pos(w, 'H9 Verify primary')).toBeLessThan(pos(w, 'H10 Verify escalation'));
    const fromH8 = reach(w, 'H8 DNS MX');
    expect(fromH8.has('H10 Verify escalation')).toBe(true);
    const parents = Object.entries(w.connections).filter(([, c]) => c.main.some((o) => o.some((t) => t.node === 'H10 Verify escalation'))).map(([n]) => n);
    expect(parents.length).toBeGreaterThan(0);
    for (const p of parents) expect(['H9 Escalate?', 'H9 Verify primary', 'H9 Route primary']).toContain(p);
  });
  it('calls the LLM normalizer only when confidence is below 0.8', () => {
    expect(text(w)).toContain('hygiene-normalizer');
    expect(text(w)).toContain('0.8');
  });
  it('writes verification_results and finishes through transition_lead', () => {
    expect(text(w)).toContain('INSERT INTO verification_results');
    expect(text(w)).toContain('transition_lead');
  });
  it('rejects company caps with the configured limits', () => {
    expect(text(w)).toContain('company_cap');
    expect(text(w)).toContain('similarity');
  });
});

describe('WF-03 research', () => {
  const w = buildWf03();
  it('claims verified leads, fetches, calls the extractor, grounds, then inserts evidence', () => {
    expect(text(w)).toContain("claim_leads('verified'");
    const order = ['Fetch pages', 'Extract facts', 'Ground facts', 'Insert evidence'];
    const idx = order.map((n) => pos(w, n));
    expect(idx.every((i) => i >= 0)).toBe(true);
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
    expect(paths(w, 'Ground facts').url).toContain('/v1/research/ground');
    expect(paths(w, 'Extract facts').url).toContain('/v1/llm/run');
  });
  it('is gated on llm_paused', () => {
    expect(text(w)).toContain('!$json.llm_paused');
  });
  it('flags injection and thin evidence, and sends no-evidence leads to needs_review', () => {
    expect(text(w)).toContain('injection_detected');
    expect(text(w)).toContain('thin_evidence');
    expect(text(w)).toContain('no_evidence');
  });
});

describe('WF-04 scoring', () => {
  const w = buildWf04();
  it('claims researched leads and calls the scorer then the tier route', () => {
    expect(text(w)).toContain("claim_leads('researched'");
    expect(pos(w, 'Score ICP')).toBeLessThan(pos(w, 'Compute tier'));
    expect(paths(w, 'Compute tier').url).toContain('/v1/score/tier');
  });
  it('rejects tier C as low_fit and moves A and B to scored', () => {
    expect(text(w)).toContain('low_fit');
    expect(text(w)).toContain("'scored'");
  });
  it('is gated on llm_paused', () => {
    expect(text(w)).toContain('!$json.llm_paused');
  });
});
