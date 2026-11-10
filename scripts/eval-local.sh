#!/usr/bin/env bash
# Runs the evaluation against a throwaway Postgres and a local rg-tools, then writes docs/EVAL_REPORT.md.
# Without GEMINI_API_KEY the gateway runs in replay mode with no recorded fixtures, so every LLM part reports
# "not run" with its reason. With GEMINI_API_KEY set and LLM_MODE=live, those parts run for real.
set -euo pipefail
source "$(dirname "$0")/lib/testdb.sh"
testdb_start
PORT_TOOLS="${EVAL_TOOLS_PORT:-18080}"
export MODE=sandbox RG_TOOLS_API_KEY=eval-key RG_WEBHOOK_SECRET=eval-secret RG_UNSUBSCRIBE_SECRET=eval-unsub
export SENDER_PHYSICAL_ADDRESS="Eval Test Co, Lahore, Pakistan" PORT="$PORT_TOOLS"
export DATABASE_URL="$TEST_DATABASE_URL" LLM_MODE="${LLM_MODE:-replay}"
(cd "$ROOT/services/rg-tools" && npx tsx src/main.ts > "$WORK/rg-tools.log" 2>&1) &
TOOLS_PID=$!
trap 'kill $TOOLS_PID 2>/dev/null || true; testdb_cleanup' EXIT
for _ in $(seq 1 40); do curl -sf "http://localhost:$PORT_TOOLS/health" >/dev/null 2>&1 && break; sleep 0.5; done
export RG_TOOLS_URL="http://localhost:$PORT_TOOLS"
cd "$ROOT/eval" && npm run eval --silent
