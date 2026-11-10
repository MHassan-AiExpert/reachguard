import { describe, expect, it } from 'vitest';
import { buildWf01 } from '../src/wf-01-intake.js';
import { stageSkeleton } from '../src/lib/skeleton.js';
import { code } from '../src/lib/nodes.js';

const wf01 = buildWf01();
const text = JSON.stringify(wf01);

describe('WF-01 intake', () => {
  it('has a POST webhook at rg/intake with raw body', () => {
    const hook = wf01.nodes.find((n) => n.type === 'n8n-nodes-base.webhook');
    expect(hook).toBeDefined();
    expect(hook!.parameters.path).toBe('rg/intake');
    expect(hook!.parameters.httpMethod).toBe('POST');
    expect((hook!.parameters.options as Record<string, unknown>).rawBody).toBe(true);
    expect(hook!.parameters.responseMode).toBe('responseNode');
  });

  it('verifies the signature through rg-tools with timestamp and signature headers', () => {
    expect(text).toContain('/v1/auth/verify-webhook');
    expect(text).toContain('x-rg-signature');
    expect(text).toContain('x-rg-timestamp');
  });

  it('validates against the lead-intake contract', () => {
    expect(text).toContain('/v1/contracts/validate');
    expect(text).toContain('lead-intake');
  });

  it('inserts idempotently', () => {
    expect(text).toContain('ON CONFLICT (idempotency_key) DO NOTHING');
  });

  it('answers 202, 200, 400, 401 and 404', () => {
    for (const c of ['202', '200', '400', '401', '404']) expect(text).toContain(`"responseCode":${c}`);
  });

  it('checks the signature before validating or touching the database', () => {
    const order = wf01.nodes.map((n) => n.name);
    const sig = text.indexOf('/v1/auth/verify-webhook');
    expect(sig).toBeGreaterThan(-1);
    expect(sig).toBeLessThan(text.indexOf('/v1/contracts/validate'));
    expect(sig).toBeLessThan(text.indexOf('INSERT INTO leads'));
    expect(order.length).toBeGreaterThan(5);
  });

  it('only accepts active campaigns and caps bulk at 500', () => {
    expect(text).toContain("status = 'active'");
    expect(text).toContain('500');
  });
});

describe('stageSkeleton', () => {
  const sk = stageSkeleton({
    name: 'WF-99 Demo',
    inputStatus: 'received',
    batch: 5,
    perLead: [code('stage logic', 'return $input.all();')],
  });
  const t = JSON.stringify(sk);

  it('has a schedule trigger and an execute-workflow trigger', () => {
    expect(sk.nodes.some((n) => n.type === 'n8n-nodes-base.scheduleTrigger')).toBe(true);
    expect(sk.nodes.some((n) => n.type === 'n8n-nodes-base.executeWorkflowTrigger')).toBe(true);
  });
  it('gates on settings, starts a run and claims leads', () => {
    expect(t).toContain('kill_switch');
    expect(t).toContain('INSERT INTO runs');
    expect(t).toContain('claim_leads');
    expect(t).toContain("'received'");
  });
  it('releases the lead on a per-lead error and ends the run', () => {
    expect(t).toContain('release_lead');
    expect(t).toContain('UPDATE runs');
    const loop = sk.nodes.find((n) => n.type === 'n8n-nodes-base.splitInBatches');
    expect(loop).toBeDefined();
  });
  it('routes stage logic failures to the error branch via continueOnFail', () => {
    const stage = sk.nodes.find((n) => n.name === 'stage logic');
    expect(stage).toBeDefined();
    expect(stage!.onError).toBe('continueErrorOutput');
  });
});
