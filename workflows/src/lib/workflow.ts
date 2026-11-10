import { createHash } from 'node:crypto';

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

export interface N8nNode {
  id: string;
  name: string;
  type: string;
  typeVersion: number;
  position: [number, number];
  parameters: Record<string, unknown>;
  credentials?: Record<string, { id: string; name: string }>;
  onError?: 'continueRegularOutput' | 'continueErrorOutput' | 'stopWorkflow';
  alwaysOutputData?: boolean;
  retryOnFail?: boolean;
  maxTries?: number;
  waitBetweenTries?: number;
  notes?: string;
  webhookId?: string;
}

export interface Conn {
  node: string;
  type: 'main';
  index: number;
}

export type Connections = Record<string, { main: Conn[][] }>;

export interface N8nWorkflow {
  id: string;
  name: string;
  nodes: N8nNode[];
  connections: Connections;
  settings: Record<string, unknown>;
  tags: { name: string }[];
  active?: boolean;
}

export const TAG = 'reachguard';
export const WF00_ID = 'rgwf00';
/** Credential names created by the credentials script. The lint rejects any other name. */
export const KNOWN_CREDENTIALS = ['RG Postgres', 'RG Tools Key', 'RG Telegram'] as const;

/** Stable id derived from the workflow name ("WF-07a Approval" becomes "rgwf07a") so re-imports update in place. */
export function workflowId(name: string): string {
  const m = /^WF-(\w+)/.exec(name);
  if (!m) throw new Error(`workflow name must start with "WF-NN": ${name}`);
  return `rgwf${m[1]!.toLowerCase()}`;
}

/** Deterministic node id so a rebuild produces an identical file. */
export function nodeId(workflowName: string, nodeName: string): string {
  const h = createHash('sha1').update(`${workflowName}\u0000${nodeName}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** A node as written by a stage author: no id or position yet. */
export type NodeSpec = Omit<N8nNode, 'id' | 'position'>;

export interface Flow {
  add<T extends NodeSpec>(node: T): T;
  connect(from: string, to: string, outputIndex?: number): void;
  chain(...names: string[]): void;
  has(name: string): boolean;
}

export interface FlowBuilder extends Flow {
  build(name: string): N8nWorkflow;
}

/** Collects nodes and connections, lays nodes out left to right, and emits a workflow. */
export function createFlow(): FlowBuilder {
  const nodes: NodeSpec[] = [];
  const connections: Connections = {};
  return {
    add(node) {
      if (nodes.some((n) => n.name === node.name)) throw new Error(`duplicate node name: ${node.name}`);
      nodes.push(node);
      return node;
    },
    connect(from, to, outputIndex = 0) {
      const entry = (connections[from] ??= { main: [] });
      while (entry.main.length <= outputIndex) entry.main.push([]);
      entry.main[outputIndex]!.push({ node: to, type: 'main', index: 0 });
    },
    chain(...names) {
      for (let i = 0; i < names.length - 1; i++) this.connect(names[i]!, names[i + 1]!);
    },
    has: (name) => nodes.some((n) => n.name === name),
    build(name) {
      return workflow(name, nodes, connections);
    },
  };
}

/** Assigns ids and a left-to-right layout (depth from the triggers), and wraps the nodes in a tagged workflow. */
export function workflow(name: string, specs: NodeSpec[], connections: Connections): N8nWorkflow {
  const depth = new Map<string, number>();
  const targets = new Set<string>();
  for (const c of Object.values(connections)) for (const outs of c.main) for (const t of outs) targets.add(t.node);
  const queue = specs.filter((n) => !targets.has(n.name)).map((n) => n.name);
  for (const q of queue) depth.set(q, 0);
  while (queue.length) {
    const cur = queue.shift()!;
    for (const outs of connections[cur]?.main ?? []) {
      for (const t of outs) {
        if (!depth.has(t.node)) {
          depth.set(t.node, depth.get(cur)! + 1);
          queue.push(t.node);
        }
      }
    }
  }
  const rowAt = new Map<number, number>();
  const nodes: N8nNode[] = specs.map((s) => {
    const d = depth.get(s.name) ?? 0;
    const row = rowAt.get(d) ?? 0;
    rowAt.set(d, row + 1);
    return { id: nodeId(name, s.name), ...s, position: [d * 260, row * 160] };
  });
  const settings: Record<string, unknown> = { executionOrder: 'v1' };
  if (!name.startsWith('WF-00')) settings.errorWorkflow = WF00_ID;
  return { id: workflowId(name), name, nodes, connections, settings, tags: [{ name: TAG }], active: false };
}

/** Returns a list of problems; an empty list means the exported JSON is safe to commit. */
export function lintWorkflow(jsonText: string): string[] {
  const errs: string[] = [];
  let w: Record<string, unknown>;
  try {
    w = JSON.parse(jsonText) as Record<string, unknown>;
  } catch {
    return ['not valid JSON'];
  }
  if ('pinData' in w) errs.push('pinData must not be committed');
  for (const k of ['executionData', 'executions', 'staticData']) {
    if (k in w) errs.push(`execution data field "${k}" must not be committed`);
  }
  const tags = Array.isArray(w.tags) ? (w.tags as { name?: string }[]) : [];
  if (!tags.some((t) => t.name === TAG)) errs.push(`workflow must be tagged "${TAG}"`);
  const nodes = Array.isArray(w.nodes) ? (w.nodes as Record<string, unknown>[]) : [];
  const seen = new Set<string>();
  for (const n of nodes) {
    const nm = String(n.name);
    if (seen.has(nm)) errs.push(`duplicate node name: ${nm}`);
    seen.add(nm);
    if ('pinData' in n) errs.push(`node ${nm} carries pinData`);
    const creds = (n.credentials ?? {}) as Record<string, Record<string, unknown>>;
    for (const [type, c] of Object.entries(creds)) {
      const extra = Object.keys(c).filter((k) => k !== 'id' && k !== 'name');
      if (extra.length) errs.push(`node ${nm} embeds credential values (${type}: ${extra.join(', ')})`);
      if (!(KNOWN_CREDENTIALS as readonly string[]).includes(String(c.name))) {
        errs.push(`node ${nm} references unknown credential "${String(c.name)}"`);
      }
    }
  }
  return errs;
}
