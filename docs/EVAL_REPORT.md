# ReachGuard evaluation report

- Date: 2026-11-10
- Git SHA: 8e591e6
- LLM mode (configured): replay
- Models used: none (no LLM call was made in this run)
- Target: rg-tools http://localhost:18080 (MODE=sandbox)
- Database: connected

**5 of 11 parts ran.** Every target on a part that ran was met.
A part that did not run says why and prints no numbers. Nothing in this file is estimated.

## Summary

| Suite | Part | Status |
|---|---|---|
| hygiene | rules | run |
| hygiene | pipeline | not run: needs the running n8n stack (make demo) and, for research and scoring, an LLM key |
| dedup | concurrency | run |
| grounding | precheck | run |
| grounding | judge | not run: LLM gateway returned HTTP 502 (provider_error) |
| injection | resistance | not run: LLM gateway returned HTTP 502 (provider_error) |
| replies | unsubscribe_rules | run |
| replies | classifier | not run: LLM gateway returned HTTP 502 (provider_error) |
| failure | claim_and_release | run |
| failure | stack_faults | not run: needs the running n8n stack and fault injection (make demo, then stop services); not part of this run |
| cost_latency | aggregate | not run: no LLM calls recorded in this database, so there is no cost or latency to report |

## hygiene

### hygiene / rules

Scope: Rule layer only: the real rg-tools address and MX routes plus the database suppression and region rules, applied in WF-02 order. It does not run WF-02 itself.

Status: run

| Metric | Result | Target | Met |
|---|---|---|---|
| planted bad leads caught with the right reason | 23/23 (100%) | reported, not targeted |  |
| clean leads blocked by the rules | 0/31 (0%) | reported, not targeted |  |

Cases: 54 of 54 passed.

### hygiene / pipeline

Scope: All 60 seed leads through WF-01 to WF-06 and the final status and reason compared with `expected`.

Status: not run: needs the running n8n stack (make demo) and, for research and scoring, an LLM key

## dedup

### dedup / concurrency

Scope: The exact SQL of WF-01 (insert lead), WF-09 (insert event) and WF-08a (create sends) from workflows/dist, fired concurrently against Postgres. It does not run n8n.

Status: run

| Metric | Result | Target | Met |
|---|---|---|---|
| concurrent duplicate scenarios handled | 4/4 (100%) | must be 100% | met |

Cases: 4 of 4 passed.

## grounding

### grounding / precheck

Scope: The deterministic /v1/copy/precheck on 30 planted drafts. Faults only the judge can see (unsupported, hidden or exaggerated claims) are out of scope for this part by design.

Status: run

| Metric | Result | Target | Met |
|---|---|---|---|
| precheck-detectable bad drafts caught | 12/12 (100%) | reported, not targeted |  |
| clean drafts failed by the precheck | 0/6 (0%) | reported, not targeted |  |

Cases: 30 of 30 passed.

### grounding / judge

Scope: The qa-judge agent plus the same code checks WF-06 applies, on the same 30 planted drafts.

Status: not run: LLM gateway returned HTTP 502 (provider_error)

## injection

### injection / resistance

Scope: The three prompt-injection fixture sites through the research-extractor and copywriter agents, scanning both outputs for the planted instructions.

Status: not run: LLM gateway returned HTTP 502 (provider_error)

## replies

### replies / unsubscribe_rules

Scope: The keyword rule that suppresses an unsubscribe request before any model sees it, run through the real /v1/events/normalize route on the 40 labeled replies.

Status: run

| Metric | Result | Target | Met |
|---|---|---|---|
| unsubscribe intent replies hit by the rule | 5/5 (100%) | reported, not targeted |  |
| false hits on replies with no unsubscribe intent | 0/35 (0%) | reported, not targeted |  |

Cases: 40 of 40 passed.

### replies / classifier

Scope: The reply-classifier agent on the 40 labeled replies, with the same code override WF-09 applies (rule hit or model intent suppresses).

Status: not run: LLM gateway returned HTTP 502 (provider_error)

## failure

### failure / claim_and_release

Scope: The claim, lease and release functions in Postgres, driven by concurrent workers. It does not stop containers or break vendors.

Status: run

| Metric | Result | Target | Met |
|---|---|---|---|
| claim, lease and release scenarios handled | 3/3 (100%) | must be 100% | met |

Cases: 3 of 3 passed.

### failure / stack_faults

Scope: Provider outage, n8n worker crash mid-run, LLM 429 storm and Redis restart.

Status: not run: needs the running n8n stack and fault injection (make demo, then stop services); not part of this run

## cost_latency

### cost_latency / aggregate

Scope: Cost and latency read back from llm_calls and runs rows written by whatever run filled the database. It measures nothing itself.

Status: not run: no LLM calls recorded in this database, so there is no cost or latency to report

