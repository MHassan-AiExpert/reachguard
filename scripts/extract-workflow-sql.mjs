// Prints a PREPARE statement for every Postgres node in workflows/dist.
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('../workflows/dist/', import.meta.url));
let n = 0;
for (const f of readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
  const w = JSON.parse(readFileSync(dir + f, 'utf8'));
  for (const node of w.nodes) {
    if (node.type !== 'n8n-nodes-base.postgres') continue;
    n++;
    console.log(`\\echo ${f} :: ${node.name}`);
    console.log(`PREPARE q${n} AS ${String(node.parameters.query).replace(/;\s*$/, '')};`);
  }
}
