// Creates the three n8n credentials the workflows reference (RG Postgres, RG Tools Key, RG Telegram) from
// environment variables, using the n8n CLI inside the running container. Values never touch the repository:
// the JSON is written to a temp file, copied into the container, imported, and removed from both places.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const need = (k) => {
  const v = process.env[k];
  if (!v) throw new Error(`set ${k} (see .env.example)`);
  return v;
};
const creds = [
  { id: 'rg-postgres', name: 'RG Postgres', type: 'postgres', data: { host: 'postgres', port: 5432, database: need('POSTGRES_DB'), user: need('POSTGRES_USER'), password: need('POSTGRES_PASSWORD'), ssl: 'disable' } },
  { id: 'rg-tools-key', name: 'RG Tools Key', type: 'httpHeaderAuth', data: { name: 'x-rg-key', value: need('RG_TOOLS_API_KEY') } },
  ...(process.env.TELEGRAM_BOT_TOKEN ? [{ id: 'rg-telegram', name: 'RG Telegram', type: 'telegramApi', data: { accessToken: process.env.TELEGRAM_BOT_TOKEN } }] : []),
];
const dir = mkdtempSync(path.join(tmpdir(), 'rg-creds-'));
const file = path.join(dir, 'credentials.json');
const run = (args) => execFileSync('docker', ['compose', ...args], { stdio: 'inherit' });
try {
  writeFileSync(file, JSON.stringify(creds), { mode: 0o600 });
  run(['cp', file, 'n8n:/tmp/rg-credentials.json']);
  run(['exec', '-T', 'n8n', 'n8n', 'import:credentials', '--input=/tmp/rg-credentials.json']);
} finally {
  run(['exec', '-T', 'n8n', 'rm', '-f', '/tmp/rg-credentials.json']);
  rmSync(dir, { recursive: true, force: true });
}
console.log(`created ${creds.length} credentials${process.env.TELEGRAM_BOT_TOKEN ? '' : ' (no TELEGRAM_BOT_TOKEN: Telegram alerts and approvals stay off)'}`);
