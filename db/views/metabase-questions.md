# Metabase questions

Metabase runs in the compose stack on port 3000. Connect it to the `reachguard` database with a read-only role
(create one with `GRANT SELECT` on the views below; do not give Metabase the app role). Each dashboard is a few
saved questions over the SQL views and tables in `db/migrations/0001_init.sql`.

## 1. Funnel
- Leads by status: `SELECT * FROM v_funnel ORDER BY leads DESC;`
- Why leads left the pipeline:
  ```sql
  SELECT to_status, reason, count(*) FROM lead_transitions
  WHERE to_status IN ('rejected','suppressed','needs_review','failed')
  GROUP BY 1, 2 ORDER BY 3 DESC;
  ```

## 2. Hygiene
- Share blocked by reason: the query above filtered to `to_status IN ('rejected','suppressed')`.
- Verifier spend (when a verifier is configured): sum of `cost_usd` on rows where `provider` is not `sandbox`.

## 3. Quality
- Drafts by final status: `SELECT status, count(*) FROM drafts GROUP BY 1;`
- Revision rate: `SELECT revision, count(*) FROM drafts GROUP BY 1 ORDER BY 1;`

## 4. Sending health
- `SELECT * FROM v_domain_health_rates;` (sends in 7 days, hard-bounce rate, complaint rate; the Guardian pauses a domain at 30 or more sends with bounce above 2% or complaints above 0.1%).
- Per-inbox volume: `SELECT inbox_id, date_trunc('day', sent_at) AS day, count(*) FROM sends WHERE status = 'sent' GROUP BY 1, 2;`

## 5. Replies
- Classification mix: `SELECT classification, count(*) FROM replies GROUP BY 1;`
- Open hot replies: `SELECT count(*) FROM replies WHERE next_action = 'notify_hot' AND handled_status = 'open';`
- `SELECT * FROM v_variant_performance;`

## 6. Cost
- `SELECT * FROM v_cost_per_lead;`
- `SELECT * FROM v_llm_spend_today;`
- Spend by agent: `SELECT agent, sum(cost_usd) FROM llm_calls GROUP BY 1 ORDER BY 2 DESC;`

Column names above follow the migration; if a query errors, check the view definition there first.
