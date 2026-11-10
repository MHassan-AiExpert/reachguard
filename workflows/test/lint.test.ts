import { describe, expect, it } from 'vitest';
import { lintWorkflow } from '../src/lib/workflow.js';
import { allWorkflows } from '../src/index.js';

const base = {
  name: 'WF-99 Test',
  nodes: [{ id: '1', name: 'A', type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [0, 0], parameters: {} }],
  connections: {},
  settings: {},
  tags: [{ name: 'reachguard' }],
};

describe('lintWorkflow', () => {
  it('accepts a clean tagged workflow', () => {
    expect(lintWorkflow(JSON.stringify(base))).toEqual([]);
  });

  it('rejects pinData', () => {
    const errs = lintWorkflow(JSON.stringify({ ...base, pinData: { A: [{ json: {} }] } }));
    expect(errs.join(' ')).toMatch(/pinData/);
  });

  it('rejects an inline credential value', () => {
    const bad = {
      ...base,
      nodes: [{ ...base.nodes[0], credentials: { telegramApi: { id: '1', name: 'x', data: { accessToken: 'abc' } } } }],
    };
    expect(lintWorkflow(JSON.stringify(bad)).join(' ')).toMatch(/credential/i);
  });

  it('rejects execution data', () => {
    expect(lintWorkflow(JSON.stringify({ ...base, executionData: {} })).join(' ')).toMatch(/execution/i);
  });

  it('requires the reachguard tag', () => {
    expect(lintWorkflow(JSON.stringify({ ...base, tags: [] })).join(' ')).toMatch(/reachguard/);
  });

  it('rejects duplicate node names', () => {
    const dup = { ...base, nodes: [base.nodes[0], { ...base.nodes[0], id: '2' }] };
    expect(lintWorkflow(JSON.stringify(dup)).join(' ')).toMatch(/duplicate/i);
  });
});

describe('built workflows', () => {
  const all = allWorkflows();
  it('builds at least WF-00 and WF-01', () => {
    const names = all.map((w) => w.name);
    expect(names).toContain('WF-00 Error Handler and Janitor');
    expect(names).toContain('WF-01 Intake Gateway');
  });
  it.each(all.map((w) => [w.name, w] as const))('%s is tagged, lint-clean and has unique node names', (_n, w) => {
    expect(w.tags).toEqual([{ name: 'reachguard' }]);
    const names = w.nodes.map((n) => n.name);
    expect(new Set(names).size).toBe(names.length);
    expect(lintWorkflow(JSON.stringify(w))).toEqual([]);
  });
  it('every connection refers to existing nodes', () => {
    for (const w of all) {
      const names = new Set(w.nodes.map((n) => n.name));
      for (const [from, c] of Object.entries(w.connections)) {
        expect(names.has(from), `${w.name}: ${from}`).toBe(true);
        for (const outs of c.main) for (const t of outs) expect(names.has(t.node), `${w.name}: ${t.node}`).toBe(true);
      }
    }
  });
});
