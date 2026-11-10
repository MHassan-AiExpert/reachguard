// Builds every workflow from workflows/src into workflows/dist/*.json. Run through tsx (see workflows/package.json).
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { allWorkflows } from '../workflows/src/index.ts';

const dist = fileURLToPath(new URL('../workflows/dist/', import.meta.url));
mkdirSync(dist, { recursive: true });
for (const f of readdirSync(dist)) if (f.endsWith('.json')) rmSync(dist + f);

for (const w of allWorkflows()) {
  const file = `${w.name.replace(/[^A-Za-z0-9]+/g, '-').replace(/-+$/, '')}.json`;
  writeFileSync(dist + file, JSON.stringify(w, null, 2) + '\n');
  console.log(`built ${file} (${w.nodes.length} nodes)`);
}
