import { describe, expect, it } from 'vitest';
import { buildWf05 } from '../src/wf-05-copywriter.js';
import { buildWf06, VERDICT_FN } from '../src/wf-06-qa-judge.js';
import { APPROVAL_POLICY_FN, buildWf07a, buildWf07b, CALLBACK_FN } from '../src/wf-07-approval.js';
import type { N8nWorkflow } from '../src/lib/workflow.js';

const pos = (w: N8nWorkflow, name: string): number => w.nodes.findIndex((n) => n.name === name);
const text = (w: N8nWorkflow) => JSON.stringify(w);
const url = (w: N8nWorkflow, name: string) => (w.nodes.find((n) => n.name === name)!.parameters as { url?: string }).url ?? '';
const fn = <T>(src: string, name: string): T => new Function(`${src}\nreturn ${name};`)() as T;

type Verdict = (
  j: { verdict: string; claim_checks: { step: number; claim_index: number; supported: boolean }[]; issues: { severity: string; step: number; type: string; detail: string; fix: string }[]; spam_risk: number; confidence: number },
  pre: { ok: boolean; violations: string[] },
  drafts: { step: number; claims: unknown[] }[],
  revision: number,
) => { to: string; reason: string; draft_status: string; issues: unknown[] };

const good = () => ({
  verdict: 'pass',
  claim_checks: [{ step: 1, claim_index: 0, supported: true }],
  issues: [] as { severity: string; step: number; type: string; detail: string; fix: string }[],
  spam_risk: 0.1,
  confidence: 0.9,
});
const drafts = [{ step: 1, claims: [{}] }, { step: 2, claims: [] }];
const okPre = { ok: true, violations: [] as string[] };

describe('WF-05 copywriter', () => {
  const w = buildWf05();
  it('claims scored leads and is gated on llm_paused', () => {
    expect(text(w)).toContain("claim_leads('scored'");
    expect(text(w)).toContain('!$json.llm_paused');
  });
  it('runs copywriter, precheck, then similarity, and regenerates at most once', () => {
    const order = ['Write copy', 'Precheck', 'Similarity', 'Check evaluate'].map((n) => pos(w, n));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(url(w, 'Write copy')).toContain('/v1/llm/run');
    expect(url(w, 'Precheck')).toContain('/v1/copy/precheck');
    expect(url(w, 'Similarity')).toContain('/v1/similarity');
    expect(text(w)).toContain('s.regenerated');
    expect(w.nodes.filter((n) => n.name.startsWith('Regenerate')).length).toBe(1);
  });
  it('inserts one draft row per step with a revision and moves the lead to drafted', () => {
    expect(text(w)).toContain('INSERT INTO drafts');
    expect(text(w)).toContain('revision');
    expect(text(w)).toContain('transition_lead');
  });
});

describe('WF-06 QA judge', () => {
  const w = buildWf06();
  it('claims drafted leads and is gated on llm_paused', () => {
    expect(text(w)).toContain("claim_leads('drafted'");
    expect(text(w)).toContain('!$json.llm_paused');
  });
  it('runs the deterministic precheck before the judge', () => {
    expect(pos(w, 'Precheck')).toBeGreaterThanOrEqual(0);
    expect(pos(w, 'Precheck')).toBeLessThan(pos(w, 'QA judge'));
    expect(url(w, 'Precheck')).toContain('/v1/copy/precheck');
    expect(url(w, 'QA judge')).toContain('/v1/llm/run');
  });
  describe('verdict code (stricter than the model)', () => {
    const verdict = fn<Verdict>(VERDICT_FN, 'verdict');
    it('passes a clean draft', () => {
      expect(verdict(good(), okPre, drafts, 0)).toMatchObject({ to: 'qa_passed', draft_status: 'qa_pass' });
    });
    it('fails on an unsupported claim even if the model said pass', () => {
      const j = good();
      j.claim_checks[0]!.supported = false;
      expect(verdict(j, okPre, drafts, 0).to).toBe('scored');
    });
    it('fails when a claim has no claim_check at all', () => {
      const j = good();
      j.claim_checks = [];
      expect(verdict(j, okPre, drafts, 0).to).toBe('scored');
    });
    it('fails on any high severity issue even if the model said pass', () => {
      const j = good();
      j.issues.push({ severity: 'high', step: 1, type: 'tone', detail: 'x', fix: 'y' });
      expect(verdict(j, okPre, drafts, 0).to).toBe('scored');
    });
    it('keeps low and medium issues from failing a pass', () => {
      const j = good();
      j.issues.push({ severity: 'medium', step: 1, type: 'tone', detail: 'x', fix: 'y' });
      expect(verdict(j, okPre, drafts, 0).to).toBe('qa_passed');
    });
    it('fails when spam_risk is above 0.35 but not at 0.35', () => {
      expect(verdict({ ...good(), spam_risk: 0.36 }, okPre, drafts, 0).to).toBe('scored');
      expect(verdict({ ...good(), spam_risk: 0.35 }, okPre, drafts, 0).to).toBe('qa_passed');
    });
    it('fails when the precheck found violations', () => {
      const r = verdict(good(), { ok: false, violations: ['too many links'] }, drafts, 0);
      expect(r.to).toBe('scored');
      expect(JSON.stringify(r.issues)).toContain('too many links');
    });
    it('revises while revision < 2 and stops at 2 with needs_review qa_exhausted', () => {
      const bad = { ...good(), verdict: 'revise', spam_risk: 0.9 };
      expect(verdict(bad, okPre, drafts, 0).to).toBe('scored');
      expect(verdict(bad, okPre, drafts, 1).to).toBe('scored');
      expect(verdict(bad, okPre, drafts, 2)).toMatchObject({ to: 'needs_review', reason: 'qa_exhausted' });
    });
    it('sends a model reject straight to needs_review qa_rejected', () => {
      expect(verdict({ ...good(), verdict: 'reject' }, okPre, drafts, 0)).toMatchObject({ to: 'needs_review', reason: 'qa_rejected' });
    });
  });
  it('stores the judge confidence in the qa_report for the approval gate', () => {
    expect(text(w)).toContain('qa_report');
    expect(text(w)).toContain('confidence');
  });
});

describe('WF-07a approval dispatcher', () => {
  const w = buildWf07a();
  const policy = fn<(i: { tier: string; flags: string[]; confidence: number; require_for_tiers: string[]; below: number }) => { require: boolean }>(
    APPROVAL_POLICY_FN,
    'needsApproval',
  );
  const base = { tier: 'B', flags: [] as string[], confidence: 0.9, require_for_tiers: ['A'], below: 0.7 };
  it('claims qa_passed leads', () => {
    expect(text(w)).toContain("claim_leads('qa_passed'");
  });
  it('requires approval for a configured tier, low judge confidence, or catch_all', () => {
    expect(policy({ ...base, tier: 'A' }).require).toBe(true);
    expect(policy({ ...base, confidence: 0.69 }).require).toBe(true);
    expect(policy({ ...base, flags: ['catch_all'] }).require).toBe(true);
    expect(policy(base).require).toBe(false);
  });
  it('sends signed buttons and records an approval before moving to pending_approval', () => {
    expect(url(w, 'Sign callbacks')).toContain('/v1/approvals/sign');
    expect(text(w)).toContain('INSERT INTO approvals');
    expect(text(w)).toContain('pending_approval');
    expect(text(w)).toContain('auto_policy');
  });
});

describe('WF-07b approval callback', () => {
  const w = buildWf07b();
  it('is triggered by Telegram callback queries and messages', () => {
    const t = w.nodes.find((n) => n.type === 'n8n-nodes-base.telegramTrigger');
    expect(t).toBeDefined();
    expect(t!.parameters.updates).toEqual(['callback_query', 'message']);
  });
  describe('update classification', () => {
    const classify = fn<(u: Record<string, unknown>, allowed: string[]) => { kind: string }>(CALLBACK_FN, 'classify');
    it('rejects a chat id outside the allowlist for both callbacks and messages', () => {
      const cb = { callback_query: { id: '1', data: 'x', message: { chat: { id: 999 } } } };
      const msg = { message: { chat: { id: 999 }, text: 'hi', reply_to_message: { text: 'approval:abc' } } };
      expect(classify(cb, ['111']).kind).toBe('unauthorized');
      expect(classify(msg, ['111']).kind).toBe('unauthorized');
    });
    it('accepts an allowlisted callback and an allowlisted edit reply', () => {
      expect(classify({ callback_query: { id: '1', data: 'abc', message: { chat: { id: 111 } } } }, ['111']).kind).toBe('callback');
      const id = '0b6f1c1e-7c1a-4a45-9d3e-2f1f6f1a9e11';
      const r = classify({ message: { chat: { id: 111 }, text: 'Subject: Hi\n\nNew body', reply_to_message: { text: `Edit approval:${id}` } } }, ['111']) as { kind: string; approval_id?: string; subject?: string; body?: string };
      expect(r).toMatchObject({ kind: 'edit_reply', approval_id: id, subject: 'Hi', body: 'New body' });
    });
    it('ignores unrelated messages', () => {
      expect(classify({ message: { chat: { id: 111 }, text: 'hello' } }, ['111']).kind).toBe('ignore');
    });
  });
  it('verifies the HMAC through rg-tools before acting and has no path that skips it', () => {
    expect(url(w, 'Verify callback')).toContain('/v1/approvals/verify');
    expect(pos(w, 'Verify callback')).toBeLessThan(pos(w, 'Approve'));
    expect(pos(w, 'Verify callback')).toBeLessThan(pos(w, 'Reject'));
  });
  it('checks an edit with precheck only and never calls an LLM', () => {
    expect(url(w, 'Precheck edit')).toContain('/v1/copy/precheck');
    expect(text(w)).not.toContain('/v1/llm/run');
    expect(text(w)).toContain('edited_approved');
  });
});
