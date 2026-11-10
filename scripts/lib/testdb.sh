#!/usr/bin/env bash
# Shared helper: starts a throwaway Postgres 16 (Docker if available, else local binaries), applies all
# migrations and seeds into database "rg", and exports TEST_DATABASE_URL.
# Source this file, call testdb_start, and the EXIT trap cleans up.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PORT="${PGTEST_PORT:-55432}"
PG_BIN="${PG_BIN:-/usr/lib/postgresql/16/bin}"
WORK="$(mktemp -d /tmp/rg-dbtest.XXXXXX)"
chmod 755 "$WORK"
TESTDB_MODE=local
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then TESTDB_MODE=docker; fi

runas() { if [ "$(id -u)" = "0" ]; then su postgres -c "$*"; else bash -c "$*"; fi; }

testdb_cleanup() {
  if [ "$TESTDB_MODE" = docker ]; then docker rm -f rg-dbtest >/dev/null 2>&1 || true
  else runas "$PG_BIN/pg_ctl -D $WORK/data -m immediate stop" >/dev/null 2>&1 || true; fi
  rm -rf "$WORK"
}
trap testdb_cleanup EXIT

testdb_start() {
  if [ "$TESTDB_MODE" = docker ]; then
    docker rm -f rg-dbtest >/dev/null 2>&1 || true
    docker run -d --name rg-dbtest -e POSTGRES_PASSWORD=test -p "$PORT:5432" postgres:16-alpine >/dev/null
    for _ in $(seq 1 40); do docker exec rg-dbtest pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done
    psql_run() { local db="$1"; shift; docker exec -i rg-dbtest psql -U postgres -d "$db" -v ON_ERROR_STOP=1 -q "$@" -f -; }
    TEST_DATABASE_URL="postgres://postgres:test@localhost:$PORT/rg"
  else
    mkdir -p "$WORK/data"; chown postgres:postgres "$WORK" "$WORK/data" 2>/dev/null || true
    runas "$PG_BIN/initdb -D $WORK/data -A trust" >/dev/null
    runas "$PG_BIN/pg_ctl -D $WORK/data -o '-p $PORT -k $WORK' -l $WORK/pg.log -w start" >/dev/null
    psql_run() { local db="$1"; shift; runas "psql -h $WORK -p $PORT -U postgres -d $db -v ON_ERROR_STOP=1 -q $* -f -"; }
    TEST_DATABASE_URL="postgres://postgres@/rg?host=$WORK&port=$PORT"
  fi
  export TEST_DATABASE_URL
  psql_run postgres <<< "CREATE DATABASE rg;"
  echo "== migrations"
  for f in "$ROOT"/db/migrations/*.sql; do psql_run rg < "$f"; done
  echo "== seeds"
  for f in "$ROOT"/db/seeds/*.sql; do psql_run rg < "$f"; done
}
