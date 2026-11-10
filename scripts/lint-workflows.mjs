// Lints the exported workflow JSON: no pinData, credential values or execution data; tagged; known credentials only.
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { lintWorkflow } from '../workflows/src/lib/workflow.ts';

const dist = fileURLToPath(new URL('../workflows/dist/', import.meta.url));
const files = readdirSync(dist).filter((f) => f.endsWith('.json'));
if (files.length === 0) {
  console.error('no workflows in workflows/dist; run the build first');
  process.exit(1);
}
let bad = 0;
for (const f of files) {
  const errs = lintWorkflow(readFileSync(dist + f, 'utf8'));
  if (errs.length) {
    bad += errs.length;
    for (const e of errs) console.error(`${f}: ${e}`);
  }
}
if (bad) process.exit(1);
console.log(`lint ok: ${files.length} workflows`);
