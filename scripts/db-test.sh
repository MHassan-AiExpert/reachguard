#!/usr/bin/env bash
# Starts a throwaway Postgres 16, applies migration and seeds, runs the schema and concurrency tests.
# Uses Docker when available, otherwise local Postgres 16 binaries (PG_BIN, default /usr/lib/postgresql/16/bin).
set -euo pipefail

source "$(dirname "$0")/lib/testdb.sh"
testdb_start
echo "== schema tests"
psql_run rg -At < "$ROOT/db/tests/schema.test.sql"

echo "== concurrency test (two sessions must claim different leads)"
psql_run rg <<'SQL'
INSERT INTO campaigns (name, status) VALUES ('conc', 'active');
INSERT INTO leads (campaign_id, idempotency_key, email, company_raw)
SELECT id, 'c-' || g, 'c' || g || '@conc.example', 'Conc' FROM campaigns, generate_series(1, 2) g WHERE name = 'conc';
SQL
(psql_run rg -At <<'SQL' > "$WORK/a.out"
BEGIN;
SELECT id FROM claim_leads('received', 1, 'wA') WHERE email LIKE '%@conc.example';
SELECT pg_sleep(3);
COMMIT;
SQL
) &
sleep 1
psql_run rg -At <<'SQL' > "$WORK/b.out"
SELECT id FROM claim_leads('received', 1, 'wB') WHERE email LIKE '%@conc.example';
SQL
wait
A="$(grep -E '^[0-9a-f-]{36}$' "$WORK/a.out" || true)"; B="$(grep -E '^[0-9a-f-]{36}$' "$WORK/b.out" || true)"
if [ -n "$A" ] && [ -n "$B" ] && [ "$A" != "$B" ]; then echo "concurrency ok: $A vs $B"; else echo "FAIL concurrency: A=[$A] B=[$B]"; exit 1; fi
echo "ALL DB TESTS PASSED"
