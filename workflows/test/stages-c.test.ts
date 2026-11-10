import { describe, expect, it } from 'vitest';
import { buildWf08a, buildWf08b, PRESEND_FN } from '../src/wf-08-sender.js';
import { buildWf09, ROUTE_REPLY_FN } from '../src/wf-09-events.js';
import type { N8nWorkflow } from '../src/lib/workflow.js';

const pos = (w: N8nWorkflow, name: string): number => w.nodes.findIndex((n) => n.name === name);
const node = (w: N8nWorkflow, name: string) => w.nodes.find((n) => n.name === name)!;
const text = (w: N8nWorkflow) => JSON.stringify(w);
const url = (w: N8nWorkflow, name: string) => (node(w, name).parameters as { url?: string }).url ?? '';
const query = (w: N8nWorkflow, name: string) => (node(w, name).parameters as { query?: string }).query ?? '';
const fn = <T>(src: string, name: string): T => new Function(`${src}\nreturn ${name};`)() as T;

describe('WF-08a scheduler', () => {
  const w = buildWf08a();
  it('claims approved leads and does not need the LLM', () => {
    expect(text(w)).toContain("claim_leads('approved'");
    expect(text(w)).not.toContain('llm_paused === ');
  });
  it('re-checks suppression and sender availability before planning', () => {
    expect(pos(w, 'Load send inputs')).toBeLessThan(pos(w, 'Plan times'));
    expect(query(w, 'Load send inputs')).toContain('is_suppressed');
    expect(query(w, 'Load send inputs')).toContain('sending_domains');
  });
  it('plans send times through rg-tools and writes all steps in one idempotent statement', () => {
    expect(url(w, 'Plan times')).toContain('/v1/schedule/plan');
    const q = query(w, 'Create sends');
    expect(q).toContain('INSERT INTO sends');
    expect(q).toContain('ON CONFLICT (lead_id, step) DO NOTHING');
    expect(q).toContain("'queued'");
  });
  it('does not schedule live sends unless live sending is enabled', () => {
    expect(text(w)).toContain('live_send_enabled');
  });
});

describe('WF-08b dispatcher', () => {
  const w = buildWf08b();
  it('claims due sends itself rather than through claim_leads', () => {
    expect(text(w)).not.toContain('claim_leads');
    expect(query(w, 'Claim leads')).toContain('FROM sends');
    expect(query(w, 'Claim leads')).toContain('SKIP LOCKED');
  });
  it('runs every pre-send check before calling /v1/send', () => {
    expect(pos(w, 'Pre-send checks')).toBeLessThan(pos(w, 'Block evaluate'));
    expect(pos(w, 'Block evaluate')).toBeLessThan(pos(w, 'Send email'));
    expect(url(w, 'Send email')).toContain('/v1/send');
  });
  it('queries the checks in order: kill switch, suppression, stop events, domain, inbox cap, campaign cap', () => {
    const q = query(w, 'Pre-send checks');
    const order = ['AS kill_switch', 'AS suppressed', 'AS stop_event', 'AS domain_inactive', 'AS inbox_capped', 'AS campaign_capped'].map((s) => q.indexOf(s));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
  describe('block decision', () => {
    type C = Record<'kill_switch' | 'suppressed' | 'stop_event' | 'domain_inactive' | 'inbox_capped' | 'campaign_capped', boolean>;
    const firstBlock = fn<(c: C) => { reason: string; action: 'defer' | 'cancel' } | null>(PRESEND_FN, 'firstBlock');
    const none: C = { kill_switch: false, suppressed: false, stop_event: false, domain_inactive: false, inbox_capped: false, campaign_capped: false };
    it('returns null when nothing blocks', () => expect(firstBlock(none)).toBeNull());
    it('applies the checks in priority order', () => {
      const all: C = { kill_switch: true, suppressed: true, stop_event: true, domain_inactive: true, inbox_capped: true, campaign_capped: true };
      const order: (keyof C)[] = ['kill_switch', 'suppressed', 'stop_event', 'domain_inactive', 'inbox_capped', 'campaign_capped'];
      const c = { ...all };
      for (const k of order) {
        expect(firstBlock(c)?.reason).toBe(k);
        c[k] = false;
      }
      expect(firstBlock(c)).toBeNull();
    });
    it('cancels the sequence for suppression and stop events, and only defers for pauses and caps', () => {
      expect(firstBlock({ ...none, suppressed: true })?.action).toBe('cancel');
      expect(firstBlock({ ...none, stop_event: true })?.action).toBe('cancel');
      for (const k of ['kill_switch', 'domain_inactive', 'inbox_capped', 'campaign_capped'] as const) {
        expect(firstBlock({ ...none, [k]: true })?.action).toBe('defer');
      }
    });
  });
  it('treats provider-side refusals as outcomes, not workflow errors', () => {
    const opts = (node(w, 'Send email').parameters as { options: { response: { response: { neverError: boolean; fullResponse: boolean } } } }).options;
    expect(opts.response.response.neverError).toBe(true);
    expect(opts.response.response.fullResponse).toBe(true);
  });
  it('moves a lead to in_sequence after step 1 and completes finished sequences', () => {
    expect(text(w)).toContain('in_sequence');
    expect(text(w)).toContain("'completed'");
  });
});

describe('WF-09 events', () => {
  const w = buildWf09();
  it('is a raw-body webhook at rg/events', () => {
    const hook = node(w, 'Events webhook');
    expect(hook.parameters.path).toBe('rg/events');
    expect((hook.parameters.options as Record<string, unknown>).rawBody).toBe(true);
  });
  it('verifies the signature before anything touches the database', () => {
    expect(url(w, 'Verify signature')).toContain('/v1/auth/verify-webhook');
    const insertAt = pos(w, 'Insert event');
    expect(pos(w, 'Verify signature')).toBeLessThan(insertAt);
    const dbBefore = w.nodes.slice(0, insertAt).filter((n) => n.type === 'n8n-nodes-base.postgres');
    expect(dbBefore).toEqual([]);
  });
  it('inserts the event first with the provider id conflict target, and a replay stops', () => {
    expect(query(w, 'Insert event')).toContain('ON CONFLICT (provider_event_id) WHERE provider_event_id IS NOT NULL DO NOTHING');
    const outs = w.connections['New event?']!.main;
    expect(outs[1]!.map((c) => c.node)).toEqual(['Respond duplicate']);
    expect(w.connections['Respond duplicate']).toBeUndefined();
  });
  it('branches on every event type', () => {
    const rules = (node(w, 'Route event type').parameters as { rules: { values: { outputKey: string }[] } }).rules.values.map((v) => v.outputKey);
    expect(rules).toEqual(['delivered', 'bounce_hard', 'bounce_soft', 'complaint', 'unsubscribe', 'reply', 'meeting_booked']);
  });
  it('suppresses with the right reasons and alerts on a complaint', () => {
    expect(query(w, 'Suppress hard bounce')).toContain('INSERT INTO suppression');
    expect(text(w)).toContain('bounce_soft_repeated');
    expect(text(w)).toContain('complaint');
    expect(pos(w, 'Alert complaint')).toBeGreaterThan(-1);
  });
  it('uses the configured soft bounce limit', () => {
    expect(text(w)).toContain('>= 3');
  });
  it('classifies replies with the reply-classifier agent', () => {
    expect(text(w)).toContain('reply-classifier');
    expect(url(w, 'Classify reply')).toContain('/v1/llm/run');
  });
  describe('reply routing overrides', () => {
    type Out = { classification: string; confidence: number; unsubscribe_intent: boolean; next_action: string };
    const route = fn<(o: Out, ruleHit: boolean) => { next_action: string; reason: string }>(ROUTE_REPLY_FN, 'routeReply');
    const base: Out = { classification: 'interested', confidence: 0.9, unsubscribe_intent: false, next_action: 'notify_hot' };
    it('keeps the model action when confident', () => expect(route(base, false).next_action).toBe('notify_hot'));
    it('suppresses on the keyword rule even at very low confidence', () => {
      expect(route({ ...base, confidence: 0.05 }, true).next_action).toBe('suppress');
    });
    it('suppresses when the model reports unsubscribe intent, whatever its action or confidence', () => {
      expect(route({ ...base, unsubscribe_intent: true, next_action: 'ignore', confidence: 0.3 }, false).next_action).toBe('suppress');
    });
    it('sends low confidence to human review but not at exactly 0.7', () => {
      expect(route({ ...base, confidence: 0.69 }, false).next_action).toBe('human_review');
      expect(route({ ...base, confidence: 0.7 }, false).next_action).toBe('notify_hot');
    });
  });
});
