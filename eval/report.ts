import type { Meta, PartResult, SuiteResult } from './lib/types.js';

const cell = (s: string): string => s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

function summarize(p: PartResult): string {
  const failed = p.cases.filter((c) => !c.passed).length;
  const missed = p.metrics.some((m) => m.met === false);
  return missed || failed ? `${failed} failed case(s)${missed ? ', target NOT MET' : ''}` : `${p.cases.length} of ${p.cases.length} cases passed`;
}

/**
 * Renders docs/EVAL_REPORT.md. A part that did not run prints only its reason: its metrics are never shown, so a
 * missing LLM key cannot be mistaken for a result.
 */
export function renderReport(results: SuiteResult[], meta: Meta): string {
  const parts = results.flatMap((r) => r.parts);
  const ran = parts.filter((p) => p.status === 'run');
  const missed = ran.flatMap((p) => p.metrics.filter((m) => m.met === false).map((m) => `${p.name}: ${m.name}`));
  const out: string[] = [];

  out.push('# ReachGuard evaluation report', '');
  out.push(`- Date: ${meta.date}`);
  out.push(`- Git SHA: ${meta.git_sha}`);
  out.push(`- LLM mode (configured): ${meta.llm_mode}`);
  out.push(`- Models used: ${meta.models.length ? meta.models.join(', ') : 'none (no LLM call was made in this run)'}`);
  out.push(`- Target: ${meta.target}`);
  out.push(`- Database: ${meta.db}`, '');
  out.push(`**${ran.length} of ${parts.length} parts ran.** ${missed.length ? `Targets NOT MET: ${missed.join('; ')}.` : 'Every target on a part that ran was met.'}`);
  out.push('A part that did not run says why and prints no numbers. Nothing in this file is estimated.', '');

  out.push('## Summary', '', '| Suite | Part | Result |', '|---|---|---|');
  for (const r of results) for (const p of ran.filter((x) => r.parts.includes(x))) out.push(`| ${cell(r.suite)} | ${cell(p.name)} | ${cell(summarize(p))} |`);
  out.push('');

  for (const r of results) {
    for (const p of r.parts) {
      if (p.status !== 'run') continue;
      out.push(`## ${r.suite} / ${p.name}`, '', `Scope: ${p.scope}`, '');
      if (p.metrics.length) {
        out.push('| Metric | Result | Target | Met |', '|---|---|---|---|');
        for (const m of p.metrics) {
          const met = m.met === undefined ? '' : m.met ? 'met' : 'NOT MET';
          out.push(`| ${cell(m.name)} | ${cell(m.display)} | ${cell(m.target ?? 'reported, not targeted')} | ${met} |`);
        }
        out.push('');
      }
      const failed = p.cases.filter((c) => !c.passed);
      out.push(`Cases: ${p.cases.length - failed.length} of ${p.cases.length} passed.`, '');
      if (failed.length) {
        out.push('Failed cases:', '');
        for (const c of failed.slice(0, 40)) out.push(`- ${cell(c.id)}: expected ${cell(JSON.stringify(c.expected))}, got ${cell(JSON.stringify(c.actual))}`);
        out.push('');
      }
    }
  }
  const rest = parts.filter((p) => p.status !== 'run');
  if (rest.length) {
    out.push('## Run separately', '', 'These parts need an API key or the full n8n stack and are not part of this report. Run them with `make eval-local` (API key) or the sandbox runner; none of their numbers appear here.', '');
    for (const r of results) for (const p of r.parts.filter((x) => x.status !== 'run')) out.push(`- ${cell(r.suite)} / ${cell(p.name)}: ${cell(p.scope)} Needs: ${cell(p.reason ?? 'no reason given')}`);
    out.push('');
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n') + '\n';
}
