import { timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Config } from './config.js';
import type { Db } from './db.js';
import { createSender, type SenderAdapter } from './adapters/sender/index.js';
import { createLlmProvider, type LlmProvider } from './adapters/llm/index.js';
import { createVerifier, type Verifier } from './adapters/verify/index.js';
import { loadUnsubscribeRules, type UnsubscribeRules } from './lib/classify-rules.js';
import { loadContracts, type ContractRegistry } from './lib/contracts.js';
import { loadHygieneLists, type HygieneLists } from './lib/email.js';
import type { SafeFetchDeps } from './lib/fetcher.js';
import { createPgCopyStore, type CopyStore } from './lib/copy-store.js';
import { createPgLlmStore, type LlmStore } from './lib/llm-store.js';
import { loadPricing, type Pricing } from './lib/pricing.js';
import { loadQaRules, type QaRules } from './lib/precheck.js';
import { loadScoringRules, type ScoringRules } from './lib/tier.js';
import { createPromptStore, type PromptStore } from './lib/prompts.js';
import { createMemoryCache, systemResolver, type DnsResolver, type MxCache } from './lib/mx.js';
import { registerApprovals } from './routes/approvals.js';
import { registerAuth } from './routes/auth.js';
import { registerContracts } from './routes/contracts.js';
import { registerCopy } from './routes/copy.js';
import { registerEvents } from './routes/events.js';
import { registerHealth } from './routes/health.js';
import { registerHygiene } from './routes/hygiene.js';
import { registerLeads } from './routes/leads.js';
import { registerLlm } from './routes/llm.js';
import { registerResearch } from './routes/research.js';
import { loadSendingRules, type SendingRules } from './lib/schedule.js';
import { registerSchedule } from './routes/schedule.js';
import { registerScore } from './routes/score.js';
import { registerSandbox } from './routes/sandbox.js';
import { registerSandboxSites } from './routes/sandbox-sites.js';
import { registerSend } from './routes/send.js';
import { registerUnsubscribe } from './routes/unsubscribe.js';
import { registerVerify } from './routes/verify.js';

export interface Deps {
  config: Config;
  db?: Db;
  contracts?: ContractRegistry;
  dns?: DnsResolver;
  mxCache?: MxCache;
  lists?: HygieneLists;
  verifier?: Verifier;
  llmProvider?: LlmProvider;
  llmStore?: LlmStore;
  pricing?: Pricing;
  prompts?: PromptStore;
  fetchDeps?: SafeFetchDeps;
  copyStore?: CopyStore;
  qaRules?: QaRules;
  scoring?: ScoringRules;
  sending?: SendingRules;
  /** Random source for send-time jitter; tests inject a fixed one. */
  rng?: () => number;
  sender?: SenderAdapter;
  unsubscribeRules?: UnsubscribeRules;
  webhookFetch?: typeof fetch;
}

export interface ResolvedDeps extends Deps {
  contracts: ContractRegistry;
  dns: DnsResolver;
  mxCache: MxCache;
  lists: HygieneLists;
  verifier: Verifier;
  llmProvider: LlmProvider;
  pricing: Pricing;
  prompts: PromptStore;
  qaRules: QaRules;
  scoring: ScoringRules;
  sending: SendingRules;
  rng: () => number;
  sender: SenderAdapter;
  unsubscribeRules: UnsubscribeRules;
  webhookFetch: typeof fetch;
}

const PUBLIC_PREFIXES = ['/healthz', '/u/'];

function keysMatch(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function buildServer(deps: Deps): FastifyInstance {
  const resolved: ResolvedDeps = {
    ...deps,
    contracts: deps.contracts ?? loadContracts(deps.config.contractsDir),
    dns: deps.dns ?? systemResolver,
    mxCache: deps.mxCache ?? createMemoryCache(),
    lists: deps.lists ?? loadHygieneLists(deps.config.configDir),
    verifier: deps.verifier ?? createVerifier(deps.config),
    llmProvider: deps.llmProvider ?? createLlmProvider(deps.config),
    pricing: deps.pricing ?? loadPricing(deps.config.configDir),
    prompts: deps.prompts ?? createPromptStore(deps.config.promptsDir),
    sender: deps.sender ?? createSender(deps.config),
    unsubscribeRules: deps.unsubscribeRules ?? loadUnsubscribeRules(deps.config.configDir),
    webhookFetch: deps.webhookFetch ?? fetch,
    qaRules: deps.qaRules ?? loadQaRules(deps.config.configDir),
    scoring: deps.scoring ?? loadScoringRules(deps.config.configDir),
    sending: deps.sending ?? loadSendingRules(deps.config.configDir),
    rng: deps.rng ?? Math.random,
    copyStore: deps.copyStore ?? (deps.db ? createPgCopyStore(deps.db) : undefined),
    llmStore: deps.llmStore ?? (deps.db ? createPgLlmStore(deps.db) : undefined),
  };
  const app = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024 });

  app.addHook('onRequest', async (req, reply) => {
    const url = req.url.split('?')[0] ?? '';
    if (PUBLIC_PREFIXES.some((p) => url === p || url.startsWith(p))) return;
    const header = req.headers['x-rg-key'];
    if (!keysMatch(Array.isArray(header) ? header[0] : header, deps.config.apiKey)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
  });

  registerHealth(app, resolved);
  registerAuth(app, resolved);
  registerContracts(app, resolved);
  registerHygiene(app, resolved);
  registerVerify(app, resolved);
  registerScore(app, resolved);
  registerApprovals(app, resolved);
  registerSchedule(app, resolved);
  registerLlm(app, resolved);
  registerResearch(app, resolved);
  registerSandboxSites(app, resolved);
  registerCopy(app, resolved);
  registerSend(app, resolved);
  registerUnsubscribe(app, resolved);
  registerEvents(app, resolved);
  registerSandbox(app, resolved);
  registerLeads(app, resolved);
  return app;
}
