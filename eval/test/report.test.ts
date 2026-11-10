import { describe, expect, it } from 'vitest';
import { renderReport } from '../report.js';
import type { Meta, SuiteResult } from '../lib/types.js';

const meta: Meta = { date: '2026-11-10', git_sha: 'abc1234', llm_mode: 'replay', models: [], target: 'http://localhost:8080', db: 'postgres' };

const ran: SuiteResult = {
  suite: 'dedup',
  parts: [{
    name: 'sql', scope: 'real WF-01/08/09 statements under concurrency', status: 'run', metrics: [
      { name: 'duplicate sends', value: 0, display: '0 of 3 sends', target: 'must be 0', met: true },
    ], cases: [{ id: 'c1', passed: true }],
  }],
};
const skipped: SuiteResult = {
  suite: 'replies',
  parts: [{
    name: 'classifier', scope: 'LLM classification of 40 replies', status: 'not_run', reason: 'LLM gateway returned HTTP 502', usesLlm: true,
    // A part that did not run must never leak numbers, even if a caller left some on it.
    metrics: [{ name: 'accuracy', value: 0.9, display: '36/40 (90%)' }], cases: [],
  }],
};

describe('renderReport', () => {
  it('lists a part that did not run under "Run separately" with its reason and never prints its metrics', () => {
    const md = renderReport([skipped], meta);
    expect(md).toContain('## Run separately');
    expect(md).toContain('LLM gateway returned HTTP 502');
    expect(md).not.toContain('### classifier');
    expect(md).not.toContain('36/40');
    expect(md).not.toContain('90%');
    expect(md).not.toContain('accuracy');
  });

  it('prints mode, date, git SHA and target, and says no models were used when no LLM part ran', () => {
    const md = renderReport([ran], meta);
    for (const s of ['2026-11-10', 'abc1234', 'replay', 'http://localhost:8080']) expect(md).toContain(s);
    expect(md).toMatch(/models used.*none/i);
  });

  it('lists the models that answered when an LLM part ran', () => {
    const md = renderReport([ran], { ...meta, models: ['google:gemini-2.5-flash'] });
    expect(md).toContain('google:gemini-2.5-flash');
  });

  it('prints metrics, targets and whether they were met for parts that ran', () => {
    const md = renderReport([ran], meta);
    expect(md).toContain('duplicate sends');
    expect(md).toContain('0 of 3 sends');
    expect(md).toContain('must be 0');
    expect(md).toMatch(/met/i);
  });

  it('summarizes how many parts ran and how many did not', () => {
    const md = renderReport([ran, skipped], meta);
    expect(md).toMatch(/1 of 2 parts ran/);
  });

  it('flags a missed target prominently', () => {
    const bad: SuiteResult = { suite: 'dedup', parts: [{ ...ran.parts[0]!, metrics: [{ name: 'duplicate sends', value: 2, display: '2 of 3 sends', target: 'must be 0', met: false }] }] };
    expect(renderReport([bad], meta)).toMatch(/NOT MET/);
  });

  it('does not let a pipe in a reason break the table', () => {
    const md = renderReport([{ suite: 's', parts: [{ name: 'p', scope: 'x', status: 'not_run', reason: 'a | b', metrics: [], cases: [] }] }], meta);
    expect(md).toContain('a \\| b');
  });
});
