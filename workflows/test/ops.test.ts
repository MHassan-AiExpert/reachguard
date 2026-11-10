import { describe, expect, it } from 'vitest';
import { buildWf11 } from '../src/wf-11-guardian.js';
import { buildWf14 } from '../src/wf-14-demo.js';
import type { N8nWorkflow } from '../src/lib/workflow.js';

const pos = (w: N8nWorkflow, name: string): number => w.nodes.findIndex((n) => n.name === name);
const node = (w: N8nWorkflow, name: string) => w.nodes.find((n) => n.name === name)!;
const text = (w: N8nWorkflow) => JSON.stringify(w);
const url = (w: N8nWorkflow, name: string) => (node(w, name).parameters as { url?: string }).url ?? '';
const query = (w: N8nWorkflow, name: string) => (node(w, name).parameters as { query?: string }).query ?? '';
const out = (w: N8nWorkflow, from: string, i = 0): string[] => (w.connections[from]?.main[i] ?? []).map((c) => c.node);

describe('WF-11 Domain Guardian', () => {
  const w = buildWf11();
  it('is a safety workflow: no kill-switch gate, so it keeps running when sending is stopped', () => {
    expect(text(w)).not.toContain('kill_switch');
    expect(w.settings.errorWorkflow).toBe('rgwf00');
  });
  it('reads v_domain_health_rates with the 30-send floor and the pause thresholds from config', () => {
    const q = query(w, 'Check domain health');
    expect(q).toContain('v_domain_health_rates');
    expect(q).toContain('sends_7d >= 30');
    expect(q).toContain('hard_bounce_rate > 0.02');
    expect(q).toContain('complaint_rate > 0.001');
  });
  it('pauses the domain and its inboxes in one statement and skips domains already paused', () => {
    const q = query(w, 'Check domain health');
    expect(q).toMatch(/UPDATE sending_domains[\s\S]*status = 'paused'/);
    expect(q).toMatch(/UPDATE sender_inboxes[\s\S]*status = 'paused'/);
    expect(q).toContain("status <> 'paused'");
    expect(out(w, 'Check domain health')).toEqual(['Alert domain paused']);
  });
  it('runs two schedules: every 15 minutes for health and budget, daily for DNS authentication', () => {
    const triggers = w.nodes.filter((n) => n.type === 'n8n-nodes-base.scheduleTrigger');
    const mins = triggers.map((t) => JSON.stringify(t.parameters)).map((p) => Number(/"minutesInterval":(\d+)/.exec(p)![1]));
    expect(mins.sort((a, b) => a - b)).toEqual([15, 1440]);
  });
  it('checks SPF, DKIM and DMARC per domain and does not pause on a transient DNS failure', () => {
    expect(url(w, 'DNS auth check')).toContain('/v1/hygiene/dns-auth');
    expect(JSON.stringify(node(w, 'DNS auth check').parameters)).toContain('neverError');
    expect(pos(w, 'Evaluate DNS')).toBeGreaterThan(pos(w, 'DNS auth check'));
    expect(text(w)).toContain('statusCode');
    const q = query(w, 'Record DNS result');
    expect(q).toContain('spf_ok');
    expect(q).toContain('dkim_ok');
    expect(q).toContain('dmarc_ok');
    expect(q).toContain("status = 'paused'");
  });
  it('pauses the LLM stages when today\'s spend exceeds the daily budget, and only resumes a budget pause', () => {
    const q = query(w, 'Check LLM budget');
    expect(q).toContain('v_llm_spend_today');
    expect(q).toContain('llm_daily_budget_usd');
    expect(q).toContain('llm_paused');
    expect(q).toContain('llm_paused_reason');
  });
  it('alerts on each action', () => {
    for (const n of ['Alert domain paused', 'Alert DNS failure', 'Alert LLM budget']) {
      expect(node(w, n).type).toBe('n8n-nodes-base.telegram');
    }
  });
});

describe('WF-14 Sandbox Demo Runner', () => {
  const w = buildWf14();
  it('starts from a manual trigger', () => {
    expect(node(w, 'Manual trigger').type).toBe('n8n-nodes-base.manualTrigger');
    expect(out(w, 'Manual trigger')).toEqual(['Check mode']);
  });
  it('checks the mode first and stops with an error in live mode before touching any data', () => {
    expect(url(w, 'Check mode')).toContain('/v1/schedule/plan');
    expect(out(w, 'Check mode')).toEqual(['Sandbox mode?']);
    expect(out(w, 'Sandbox mode?', 0)).toEqual(['Reset sandbox']);
    expect(out(w, 'Sandbox mode?', 1)).toEqual(['Refuse live mode']);
    expect(node(w, 'Refuse live mode').type).toBe('n8n-nodes-base.stopAndError');
    expect(w.connections['Refuse live mode']).toBeUndefined();
  });
  it('resets, seeds through the signed intake route, then runs the stages', () => {
    expect(url(w, 'Reset sandbox')).toContain('/v1/sandbox/reset');
    expect(url(w, 'Seed leads')).toContain('/v1/sandbox/seed');
    expect(pos(w, 'Reset sandbox')).toBeLessThan(pos(w, 'Seed leads'));
    expect(pos(w, 'Seed leads')).toBeLessThan(pos(w, 'Run WF-02'));
  });
  it('runs WF-02 to WF-08 in pipeline order with the demo approval between 07a and 08a', () => {
    const order = ['Run WF-02', 'Run WF-03', 'Run WF-04', 'Run WF-05', 'Run WF-06', 'Run WF-07a', 'Demo auto-approve', 'Run WF-08a', 'Run WF-08b'];
    const idx = order.map((n) => pos(w, n));
    expect(idx.every((i) => i >= 0)).toBe(true);
    for (let i = 0; i < order.length - 1; i++) expect(out(w, order[i]!)).toEqual([order[i + 1]]);
    const wfIds = Object.fromEntries(['02', '03', '04', '05', '06', '07a', '08a', '08b'].map((k) => [k, `rgwf${k}`]));
    for (const [k, id] of Object.entries(wfIds)) {
      expect(JSON.stringify(node(w, `Run WF-${k}`).parameters)).toContain(id);
    }
  });
  it('only auto-approves in the sandbox run and says so', () => {
    const q = query(w, 'Demo auto-approve');
    expect(q).toContain("'pending_approval'");
    expect(q).toContain('demo-runner');
    expect(text(w)).toContain('auto-approved');
  });
  it('loops until no work remains or the time cap passes', () => {
    expect(out(w, 'Run WF-08b')).toEqual(['Work remaining']);
    expect(query(w, 'Work remaining')).toContain('scheduled');
    expect(text(w)).toContain('deadline');
    expect(out(w, 'Loop done?', 1)).toEqual(['Wait between passes']);
    expect(out(w, 'Wait between passes')).toEqual(['Run WF-02']);
  });
  it('injects the labeled replies, waits for classification, then posts the funnel to Telegram', () => {
    expect(url(w, 'Inject replies')).toContain('/v1/sandbox/replies/batch');
    expect(pos(w, 'Inject replies')).toBeLessThan(pos(w, 'Replies pending'));
    expect(query(w, 'Replies pending')).toContain('next_action IS NULL');
    expect(pos(w, 'Replies pending')).toBeLessThan(pos(w, 'Funnel summary'));
    expect(pos(w, 'Funnel summary')).toBeLessThan(pos(w, 'Post summary'));
    expect(node(w, 'Post summary').type).toBe('n8n-nodes-base.telegram');
    const q = query(w, 'Funnel summary');
    for (const t of ['leads', 'verification_results', 'llm_calls', 'replies']) expect(q).toContain(t);
  });
});
