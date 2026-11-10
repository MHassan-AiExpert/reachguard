// Imports workflows/dist/*.json into the running n8n container with the n8n CLI.
// Credentials are created separately from environment variables and are never part of these files.
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const dist = fileURLToPath(new URL('../workflows/dist/', import.meta.url));
const files = readdirSync(dist).filter((f) => f.endsWith('.json')).sort();
if (files.length === 0) {
  console.error('no workflows in workflows/dist; run make build-workflows first');
  process.exit(1);
}
const run = (args) => execFileSync('docker', ['compose', ...args], { stdio: 'inherit' });
run(['exec', '-T', 'n8n', 'mkdir', '-p', '/tmp/rg-workflows']);
for (const f of files) {
  run(['cp', `${dist}${f}`, `n8n:/tmp/rg-workflows/${f}`]);
  run(['exec', '-T', 'n8n', 'n8n', 'import:workflow', `--input=/tmp/rg-workflows/${f}`]);
}
console.log(`imported ${files.length} workflows`);
