#!/usr/bin/env bash
# Parses and type-checks every Postgres statement in workflows/dist against the real schema (PREPARE, nothing executes).
# This catches SQL syntax and parameter-type errors that unit tests on workflow JSON cannot see.
set -euo pipefail
source "$(dirname "$0")/lib/testdb.sh"
testdb_start >/dev/null 2>&1
node "$(dirname "$0")/extract-workflow-sql.mjs" > "$WORK/prepare.sql"
out="$(psql_run rg -v ON_ERROR_STOP=0 < "$WORK/prepare.sql" 2>&1 | grep -B1 'ERROR:' || true)"
if [ -n "$out" ]; then echo "$out"; echo "FAIL: workflow SQL does not prepare"; exit 1; fi
echo "workflow SQL ok: $(grep -c '^PREPARE' "$WORK/prepare.sql") statements prepared"
