import type { LlmProvider, LlmRequest, LlmResponse } from '../src/adapters/llm/types.js';
import type { LlmCallRow, LlmStore } from '../src/lib/llm-store.js';

export interface MemoryLlmStore extends LlmStore {
  calls: (LlmCallRow & { id: string })[];
  versions: Map<string, string>;
  settings: Map<string, unknown>;
  spend: number;
}

export function memoryLlmStore(
  init: { paused?: boolean; budget?: number; spend?: number } = {},
): MemoryLlmStore {
  const store: MemoryLlmStore = {
    calls: [],
    versions: new Map(),
    settings: new Map<string, unknown>([
      ['llm_paused', init.paused ?? false],
      ['llm_daily_budget_usd', init.budget ?? 5],
    ]),
    spend: init.spend ?? 0,
    async getSetting(key) {
      return store.settings.get(key);
    },
    async spendToday() {
      return store.spend;
    },
    async insertCall(row) {
      const id = `00000000-0000-4000-8000-${String(store.calls.length + 1).padStart(12, '0')}`;
      store.calls.push({ ...row, id });
      return id;
    },
    async upsertPromptVersion(agent, version, hash) {
      store.versions.set(`${agent}@${version}`, hash);
    },
  };
  return store;
}

export interface FakeProvider extends LlmProvider {
  requests: LlmRequest[];
}

export function fakeProvider(
  replies: (string | Error)[],
  tokens = { input: 1000, output: 500 },
): FakeProvider {
  const requests: LlmRequest[] = [];
  let i = 0;
  return {
    requests,
    async generate(req): Promise<LlmResponse> {
      requests.push(req);
      const next = replies[Math.min(i, replies.length - 1)] as string | Error;
      i++;
      if (next instanceof Error) throw next;
      return { text: next, input_tokens: tokens.input, output_tokens: tokens.output };
    },
  };
}
