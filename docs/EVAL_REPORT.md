# ReachGuard evaluation report

- Date: 2026-11-10
- Git SHA: fca5599
- LLM mode (configured): replay
- Models used: none (no LLM call was made in this run)
- Target: rg-tools http://localhost:18080 (MODE=sandbox)
- Database: connected

**5 of 11 parts ran.** Every target on a part that ran was met.
A part that did not run says why and prints no numbers. Nothing in this file is estimated.

## Summary

| Suite | Part | Result |
|---|---|---|
| hygiene | rules | 54 of 54 cases passed |
| dedup | concurrency | 4 of 4 cases passed |
| grounding | precheck | 30 of 30 cases passed |
| replies | unsubscribe_rules | 40 of 40 cases passed |
| failure | claim_and_release | 3 of 3 cases passed |

## hygiene / rules

Scope: Rule layer only: the real rg-tools address and MX routes plus the database suppression and region rules, applied in WF-02 order. It does not run WF-02 itself.

| Metric | Result | Target | Met |
|---|---|---|---|
| planted bad leads caught with the right reason | 23/23 (100%) | reported, not targeted |  |
| clean leads blocked by the rules | 0/31 (0%) | reported, not targeted |  |

Cases: 54 of 54 passed.

## dedup / concurrency

Scope: The exact SQL of WF-01 (insert lead), WF-09 (insert event) and WF-08a (create sends) from workflows/dist, fired concurrently against Postgres. It does not run n8n.

| Metric | Result | Target | Met |
|---|---|---|---|
| concurrent duplicate scenarios handled | 4/4 (100%) | must be 100% | met |

Cases: 4 of 4 passed.

## grounding / precheck

Scope: The deterministic /v1/copy/precheck on 30 planted drafts. Faults only the judge can see (unsupported, hidden or exaggerated claims) are out of scope for this part by design.

| Metric | Result | Target | Met |
|---|---|---|---|
| precheck-detectable bad drafts caught | 12/12 (100%) | reported, not targeted |  |
| clean drafts failed by the precheck | 0/6 (0%) | reported, not targeted |  |

Cases: 30 of 30 passed.

## replies / unsubscribe_rules

Scope: The keyword rule that suppresses an unsubscribe request before any model sees it, run through the real /v1/events/normalize route on the 40 labeled replies.

| Metric | Result | Target | Met |
|---|---|---|---|
| unsubscribe intent replies hit by the rule | 5/5 (100%) | reported, not targeted |  |
| false hits on replies with no unsubscribe intent | 0/35 (0%) | reported, not targeted |  |

Cases: 40 of 40 passed.

## failure / claim_and_release

Scope: The claim, lease and release functions in Postgres, driven by concurrent workers. It does not stop containers or break vendors.

| Metric | Result | Target | Met |
|---|---|---|---|
| claim, lease and release scenarios handled | 3/3 (100%) | must be 100% | met |

Cases: 3 of 3 passed.

## Run separately

These parts need an API key or the full n8n stack and are not part of this report. Run them with `make eval-local` (API key) or the sandbox runner; none of their numbers appear here.

- hygiene / pipeline: All 60 seed leads through WF-01 to WF-06 and the final status and reason compared with `expected`. Needs: needs the running n8n stack (make demo) and, for research and scoring, an LLM key
- grounding / judge: The qa-judge agent plus the same code checks WF-06 applies, on the same 30 planted drafts. Needs: LLM gateway returned HTTP 502 (provider_error)
- injection / resistance: The three prompt-injection fixture sites through the research-extractor and copywriter agents, scanning both outputs for the planted instructions. Needs: LLM gateway returned HTTP 502 (provider_error)
- replies / classifier: The reply-classifier agent on the 40 labeled replies, with the same code override WF-09 applies (rule hit or model intent suppresses). Needs: LLM gateway returned HTTP 502 (provider_error)
- failure / stack_faults: Provider outage, n8n worker crash mid-run, LLM 429 storm and Redis restart. Needs: needs the running n8n stack and fault injection (make demo, then stop services); not part of this run
- cost_latency / aggregate: Cost and latency read back from llm_calls and runs rows written by whatever run filled the database. It measures nothing itself. Needs: no LLM calls recorded in this database, so there is no cost or latency to report

