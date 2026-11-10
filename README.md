# ReachGuard

A multi-agent B2B cold-outreach and lead-hygiene pipeline built on n8n. Leads enter through a signed webhook, move through a Postgres state machine (hygiene, research, scoring, copy, QA, approval, sending, reply handling), and every risky step is gated by deterministic code, not by a model's say-so.

Author: Muhammad Hassan, AI Automation Engineer & Full Stack Developer.

## What it does

- **Intake** (WF-01): HMAC-signed, replay-protected webhook; idempotent inserts; one lead per email even under concurrent delivery.
- **Hygiene** (WF-02): normalisation, role, disposable and free-provider checks, MX lookup, suppression and region rules, company de-duplication and cooldown.
- **Research** (WF-03): SSRF-guarded page fetch, evidence extraction by an LLM agent, claims accepted only if they quote a verbatim snippet from the page.
- **Scoring** (WF-04): weighted ICP score, tier A/B/C, caps for catch-all addresses and thin evidence.
- **Copy and QA** (WF-05, WF-06): a copywriter agent, then deterministic pre-checks (word counts, links, banned phrases, subject rules, grounding against the lead's own evidence ids) and a separate judge call. Code can override a lenient judge.
- **Approval** (WF-07a/b): Telegram approval with a chat allowlist and signed callback data, for tier A and low-confidence drafts.
- **Sending** (WF-08a/b): send windows in the lead's time zone, jitter, inbox and campaign caps, unsubscribe link and physical address on every message. Sandbox sends go to Mailpit.
- **Replies and events** (WF-09): classification; unsubscribe always wins (keyword rule first, model second); bounces and complaints feed suppression.
- **Guardian** (WF-11): pauses a sending domain when bounce or complaint rates cross the configured limits, pauses LLM calls when the daily budget is spent, checks SPF, DKIM and DMARC daily.
- **Errors and janitor** (WF-00), **sandbox demo runner** (WF-14).

## Architecture in one paragraph

n8n (queue mode) orchestrates. Postgres 16 holds all state and enforces the lead state machine in SQL (`transition_lead`, `claim_leads` with `SKIP LOCKED` leases, `release_lead` to dead letters). n8n nodes cannot read the environment or compute HMACs, so everything that needs secrets, DNS, fetching, validation or LLM calls lives in `rg-tools`, a small Fastify and TypeScript service. Workflows are written as TypeScript builders and compiled to importable JSON in `workflows/dist/`. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Quick start (sandbox)

Requirements: Docker, Node 22.

```bash
cp .env.example .env            # fill the change-me values; pin N8N_VERSION
make up                         # postgres, redis, n8n, workers, rg-tools, mailpit, metabase
make migrate && make seed
make build-workflows && make import-workflows
set -a; . ./.env; set +a
node scripts/create-credentials.mjs
TELEGRAM_ALERT_CHAT_ID=<id> bash scripts/seed-settings.sh   # optional, for Telegram
```

Then open n8n at http://localhost:5678, activate the workflows, and run `WF-14 Sandbox Demo Runner`. Emails appear in Mailpit at http://localhost:8025. Full walkthrough: [docs/DEMO_SCRIPT.md](docs/DEMO_SCRIPT.md).

The research, scoring, copy, judge and reply agents need an LLM key (`GEMINI_API_KEY`). No recorded LLM fixtures ship with the repository yet, so `LLM_MODE=replay` cannot serve those agents until fixtures are recorded from a live run (see the runbook).

## Tests and evaluation

```bash
make test                # database, rg-tools (with Postgres) and workflow tests
make lint
make check-workflow-sql  # prepares every workflow SQL statement against the migrated schema
make validate-sandbox    # seed data against the contracts
make eval-local          # evaluation on a throwaway Postgres, writes docs/EVAL_REPORT.md
```

The evaluation report states which parts ran and which did not, and prints numbers only for parts that ran. See [docs/EVAL_REPORT.md](docs/EVAL_REPORT.md).

## Modes and safety

`MODE=sandbox` is the default. Live sending needs `MODE=live` and `LIVE_SEND_ENABLED=true`. The demo runner refuses to run in live mode, and the sandbox reset refuses outside sandbox mode.

## Status of live integrations

| Integration | State |
|---|---|
| Mailpit sender (sandbox) | implemented |
| Gemini and OpenAI LLM providers | implemented; not exercised against the real APIs by the committed tests |
| Email verifier (live) | pending: throws `NotConfigured` until a vendor adapter is written against current vendor documentation |
| Smartlead sender and event adapter | pending: sender throws `NotConfigured`, the events route returns 501 |
| Web search provider | pending |

The committed tests do not run anything against a real vendor, a real mailbox or a running n8n instance. The workflow JSON is generated and linted, and every SQL statement is prepared against the real schema, but the JSON has not been import-tested in n8n.

## Documents

[ARCHITECTURE](docs/ARCHITECTURE.md) · [RUNBOOK](docs/RUNBOOK.md) · [COMPLIANCE](docs/COMPLIANCE.md) · [DEMO_SCRIPT](docs/DEMO_SCRIPT.md) · [EVAL_REPORT](docs/EVAL_REPORT.md) · [CASE_STUDY](docs/CASE_STUDY.md) · [SPEC](docs/SPEC.md)

Deliverability is not guaranteed by software. It depends on domain authentication, warmup, content and list quality. This is engineering guidance, not legal advice.
