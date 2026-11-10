# Compliance and security

This is engineering guidance, not legal advice. Have counsel confirm the rules for each region before any live send.

## What the system enforces

| Area | Control |
|---|---|
| CAN-SPAM (US) | Subject length and presence checked in code, deceptive subjects left to the QA judge, physical postal address (`SENDER_PHYSICAL_ADDRESS`) in every message, working opt-out. |
| GDPR and PECR (EU, UK) | Corporate addresses only (free providers blocked by default), `consent_basis` recorded per lead, region rules configurable in `region_rules`. |
| Strict regimes (for example Germany, Canada) | `blocked` or `restricted` by default because prior consent is typically required. Change only on counsel's advice. |
| Unsubscribe | One-click header plus visible link. An unsubscribe always wins: the keyword rule runs before any model, and suppression is immediate. |
| Erasure | `DELETE /v1/leads/:id` removes the lead and related rows and stores a hashed-email suppression so the person is not re-imported. |
| Retention | `raw_payload` 90 days, events 365 days (`config/defaults.yaml`). Only business contact details and public business roles are collected. |

## Security controls

- HMAC-signed, timestamped webhooks with replay protection and constant-time comparison.
- Service key between n8n and rg-tools; secrets only in n8n credentials and environment, never in workflow JSON (the lint rejects credential values, `pinData` and execution data). `N8N_BLOCK_ENV_ACCESS_IN_NODE=true`.
- SSRF guard in the page fetcher: http and https only, loopback, private, link-local and metadata ranges blocked (also after redirects and DNS resolution), caps on redirects, size and time.
- Prompt-injection defence: untrusted content is delimited and treated as data, outputs are schema-validated, claims must quote a verbatim snippet, the judge is a separate call, and no agent can send email or write a suppression.
- Telegram approvals use a chat allowlist and signed callback data.
- CI runs a secret scan over the tree and history and an image scan.

## Not covered

Deliverability is not guaranteed by software. Live sending needs domain authentication, warmup and a supervised pilot (see the runbook). Regional law must be confirmed by counsel.
