import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

export function readJson<T>(root: string, rel: string): T {
  return JSON.parse(readFileSync(path.join(root, rel), 'utf8')) as T;
}

/** The query text of one Postgres node in the built workflows, so the eval runs the statement n8n runs. */
export function workflowStatement(root: string, workflowPrefix: string, node: string): string {
  const dir = path.join(root, 'workflows/dist');
  const file = readdirSync(dir).find((f) => f.startsWith(workflowPrefix) && f.endsWith('.json'));
  if (!file) throw new Error(`no built workflow starting with ${workflowPrefix} in workflows/dist (run make build-workflows)`);
  const wf = JSON.parse(readFileSync(path.join(dir, file), 'utf8')) as { nodes: { name: string; parameters: { query?: string } }[] };
  const q = wf.nodes.find((n) => n.name === node)?.parameters.query;
  if (!q) throw new Error(`${file} has no Postgres node named "${node}"`);
  return q;
}

export const uniq = <T>(xs: T[]): T[] => [...new Set(xs)];
export const host = (website: string): string => new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(website) ? website : `https://${website}`).hostname.replace(/^www\./, '');
