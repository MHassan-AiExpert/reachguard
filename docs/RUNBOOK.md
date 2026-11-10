# Runbook

## Start, stop, upgrade, back up

- Start: `make up`. Stop: `make down`. Data lives in Docker volumes.
- Upgrade: bump `N8N_VERSION` in `.env`, `make up`, then `make build-workflows && make import-workflows`. Re-import after every workflow change.
- Back up: `docker compose exec -T postgres pg_dump -U $POSTGRES_USER $POSTGRES_DB > backup.sql`. Restore into an empty database with `psql < backup.sql`. Also keep `N8N_ENCRYPTION_KEY`; without it saved credentials cannot be decrypted.

## First-time setup

1. `make migrate && make seed`.
2. `set -a; . ./.env; set +a; node scripts/create-credentials.mjs` creates the three n8n credentials from environment variables.
3. `TELEGRAM_ALERT_CHAT_ID=... TELEGRAM_APPROVER_CHAT_IDS=... bash scripts/seed-settings.sh` stores chat ids (nodes cannot read the environment).
4. Activate the workflows in n8n.

## A domain was auto-paused

Guardian pauses a domain when, over 7 days, it has at least 30 sends and the hard-bounce rate is above 2% or the complaint rate above 0.1%. Look at `SELECT * FROM v_domain_health_rates;` and the recent `events`. Fix the cause (list quality, DNS authentication, content). Resume by setting the domain and its inboxes back to active in `sending_domains` and `sender_inboxes`. Do not resume while the rate is still above the limit; Guardian will pause it again.

## Dead letters are growing

`SELECT stage, error, count(*) FROM dead_letters WHERE status = 'open' GROUP BY 1, 2;`. Fix the cause, then requeue: set the lead's status back to the stage input status, clear `locked_by`, `locked_at`, `attempts`, `next_attempt_at`, and mark the dead letter `requeued`.

## LLM outage or budget exhausted

Outage: rg-tools returns a provider error, stages retry with backoff and eventually dead-letter. Budget: calls return 429 and Guardian sets `llm_paused` (reason `budget`); it resumes when spend falls back under the budget (next day). To resume manually: `UPDATE settings SET value = 'false' WHERE key = 'llm_paused';`. Raise the limit with `settings.llm_daily_budget_usd`.

## Recording replay fixtures

No LLM fixtures ship yet. To record: run a live pass with a key (`LLM_MODE=live`), then store each prompt-hash response in `services/rg-tools/test/fixtures/llm/` so `LLM_MODE=replay` can serve it. Until then, replay mode reports every agent call as unavailable and the evaluation marks those parts "not run".

If WF-09 is interrupted between inserting an event and acting on it, replaying the same provider event is safe: the event insert is idempotent, and the replay recovers the follow-up step.

## Adding a campaign, domain or inbox

Insert into `campaigns` (status `active`), `sending_domains` and `sender_inboxes` (see `db/seeds/001_campaign.sql` and `003_sender.sql`). Set the domain's DKIM selector to match `DKIM_SELECTOR`. Keep `inbox_daily_limit` low while warming up.

## Unsubscribe and erasure

Unsubscribe links and replies suppress the address immediately and stop the sequence. To erase a person: `DELETE /v1/leads/:id` on rg-tools removes the lead and related rows and stores a hashed-email suppression so they are not re-imported.

## Rotating secrets

Change the value in `.env`, `make up`, rerun `node scripts/create-credentials.mjs` (re-imports credentials). Rotating `RG_WEBHOOK_SECRET` or `RG_UNSUBSCRIBE_SECRET` invalidates in-flight signatures and unsubscribe links already sent; do it deliberately.

## Promoting sandbox to live

1. SPF, DKIM, DMARC pass on every sending domain (Guardian's DNS check reports this).
2. Warm up the inboxes; keep daily limits low.
3. Counsel has signed off the region rules in `region_rules`.
4. Implement and test the live verifier and sender adapters (currently pending).
5. Run a supervised pilot of about 20 leads with approval required for every tier.
6. Only then set `MODE=live` and `LIVE_SEND_ENABLED=true`.
