#!/usr/bin/env bash
# Starts a throwaway Postgres 16, applies migration and seeds, runs the schema and concurrency tests.
# Uses Docker when available, otherwise local Postgres 16 binaries (PG_BIN, default /usr/lib/postgresql/16/bin).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${PGTEST_PORT:-55432}"
PG_BIN="${PG_BIN:-/usr/lib/postgresql/16/bin}"
WORK="$(mktemp -d /tmp/rg-dbtest.XXXXXX)"
chmod 755 "$WORK"
MODE=local
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then MODE=docker; fi

runas() { if [ "$(id -u)" = "0" ]; then su postgres -c "$*"; else bash -c "$*"; fi; }

cleanup() {
  if [ "$MODE" = docker ]; then docker rm -f rg-dbtest >/dev/null 2>&1 || true
  else runas "$PG_BIN/pg_ctl -D $WORK/data -m immediate stop" >/dev/null 2>&1 || true; fi
  rm -rf "$WORK"
}
trap cleanup EXIT

if [ "$MODE" = docker ]; then
  docker rm -f rg-dbtest >/dev/null 2>&1 || true
  docker run -d --name rg-dbtest -e POSTGRES_PASSWORD=test -p "$PORT:5432" postgres:16-alpine >/dev/null
  for _ in $(seq 1 40); do docker exec rg-dbtest pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done
  psql_run() { local db="$1"; shift; docker exec -i rg-dbtest psql -U postgres -d "$db" -v ON_ERROR_STOP=1 -q "$@" -f -; }
else
  mkdir -p "$WORK/data"; chown postgres:postgres "$WORK" "$WORK/data" 2>/dev/null || true
  runas "$PG_BIN/initdb -D $WORK/data -A trust" >/dev/null
  runas "$PG_BIN/pg_ctl -D $WORK/data -o '-p $PORT -k $WORK' -l $WORK/pg.log -w start" >/dev/null
  psql_run() { local db="$1"; shift; runas "psql -h $WORK -p $PORT -U postgres -d $db -v ON_ERROR_STOP=1 -q $* -f -"; }
fi

psql_run postgres <<< "CREATE DATABASE rg;"
echo "== migration"
psql_run rg < "$ROOT/db/migrations/0001_init.sql"
echo "== seeds"
for f in "$ROOT"/db/seeds/*.sql; do psql_run rg < "$f"; done
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
