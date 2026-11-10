export interface Metric {
  name: string;
  value: number;
  /** Human text such as "10/10 (100%)". Printed in the report only when the part ran. */
  display: string;
  /** Target as text, for example "must be 0". Omitted for metrics that are reported, not targeted. */
  target?: string;
  /** Whether the target was met. Omitted when there is no target. */
  met?: boolean;
}

export interface Case {
  id: string;
  passed: boolean;
  expected?: unknown;
  actual?: unknown;
}

/** One measurable piece of a suite. A part that could not run says why and carries no metrics worth printing. */
export interface PartResult {
  name: string;
  /** What this part does and does not cover, in one sentence. */
  scope: string;
  status: 'run' | 'not_run';
  reason?: string;
  /** True when this part calls an LLM, so the report can say which models were used. */
  usesLlm?: boolean;
  metrics: Metric[];
  cases: Case[];
}

export interface SuiteResult {
  suite: string;
  parts: PartResult[];
}

export interface Meta {
  date: string;
  git_sha: string;
  /** LLM mode the stack is configured for (replay or live). */
  llm_mode: string;
  /** Models that actually answered calls during this run. Empty when no LLM part ran. */
  models: string[];
  target: string;
  db: string;
}

export interface Db {
  query(text: string, params?: unknown[]): Promise<{ rows: any[] }>;
}

export interface ApiReply {
  status: number;
  json: any;
}

export interface Api {
  post(route: string, body: unknown): Promise<ApiReply>;
}

export type LlmOutcome = { ok: true; output: any } | { ok: false; reason: string };
export type LlmCaller = (agent: string, variables: Record<string, unknown>) => Promise<LlmOutcome>;

export interface Ctx {
  api: Api;
  db: Db | null;
  root: string;
  /** rg-tools MODE as reported by the service; DB-writing suites refuse to run unless this is "sandbox". */
  mode: string;
  llm: LlmCaller;
  /** Whether the LLM gateway answered a probe call, and why not if it did not. */
  llmStatus: { available: boolean; reason?: string; model?: string };
}

export const notRun = (name: string, scope: string, reason: string, usesLlm = false): PartResult => ({
  name,
  scope,
  status: 'not_run',
  reason,
  usesLlm,
  metrics: [],
  cases: [],
});

export const fraction = (n: number, d: number): string => (d === 0 ? '0/0' : `${n}/${d} (${Math.round((n / d) * 1000) / 10}%)`);
