#!/usr/bin/env bash
# Stores the Telegram chat IDs in the settings table (n8n nodes cannot read environment variables).
# Usage: TELEGRAM_ALERT_CHAT_ID=123 TELEGRAM_APPROVER_CHAT_IDS=123,456 bash scripts/seed-settings.sh
set -euo pipefail
alert="${TELEGRAM_ALERT_CHAT_ID:?set TELEGRAM_ALERT_CHAT_ID}"
approvers="${TELEGRAM_APPROVER_CHAT_IDS:-$alert}"
json=$(printf '%s' "$approvers" | awk -F, '{printf "["; for(i=1;i<=NF;i++){printf "%s\"%s\"", (i>1?",":""), $i}; printf "]"}')
docker compose exec -T postgres sh -c 'psql -U $POSTGRES_USER -d $POSTGRES_DB -v ON_ERROR_STOP=1 -q' <<SQL
INSERT INTO settings (key, value) VALUES ('telegram_alert_chat_id', to_jsonb('${alert}'::text))
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
INSERT INTO settings (key, value) VALUES ('telegram_approver_chat_ids', '${json}'::jsonb)
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
SQL
echo "stored telegram chat settings"
