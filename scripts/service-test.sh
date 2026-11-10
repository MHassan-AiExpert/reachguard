#!/usr/bin/env bash
# Runs the rg-tools test suite, including the database-backed tests, against a throwaway Postgres.
set -euo pipefail
source "$(dirname "$0")/lib/testdb.sh"
testdb_start
cd "$ROOT/services/rg-tools"
npx vitest run "$@"
