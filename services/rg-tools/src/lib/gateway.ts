import path from 'node:path';
import { splitModel, type LlmProvider } from '../adapters/llm/types.js';
import type { Config } from '../config.js';
import { checkBudget } from './budget.js';
import type { ContractRegistry } from './contracts.js';
import { NotConfigured } from './errors.js';
import type { LlmStore } from './llm-store.js';
import { computeCost, type Pricing } from './pricing.js';
import { MissingVariable, UnknownAgent, type PromptStore } from './prompts.js';

export interface GatewayDeps {
  config: Config;
  provider: LlmProvider;
  store: LlmStore;
  prompts: PromptStore;
  contracts: ContractRegistry;
  pricing: Pricing;
}

export interface GatewayInput {
  agent: string;
  variables: Record<string, unknown>;
  lead_id?: string;
  run_id?: string;
  prompt_version?: string;
}

export interface GatewayResult {
  status: number;
  body: Record<string, unknown>;
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const t = text.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/i.exec(t);
  try {
    return { ok: true, value: JSON.parse(fenced ? (fenced[1] as string) : t) };
  } catch (err) {
    return { ok: false, error: `output is not valid JSON: ${(err as Error).message}` };
  }
}

export async function runLlm(deps: GatewayDeps, input: GatewayInput): Promise<GatewayResult> {
  const { config, provider, store, prompts, contracts, pricing } = deps;

  let rendered;
  try {
    rendered = prompts.render(input.agent, input.variables);
  } catch (err) {
    if (err instanceof UnknownAgent)
      return { status: 400, body: { error: 'unknown_agent', message: err.message } };
    if (err instanceof MissingVariable)
      return { status: 400, body: { error: 'missing_variable', message: err.message } };
    throw err;
  }
  if (input.prompt_version && input.prompt_version !== rendered.version) {
    return {
      status: 400,
      body: {
        error: 'prompt_version_unavailable',
        message: `Only version ${rendered.version} is deployed for ${input.agent}`,
      },
    };
  }

  const decision = await checkBudget(store, config.llmDailyBudgetUsd);
  if (!decision.ok) return { status: 429, body: { error: 'budget_exhausted', reason: decision.reason } };

  await store.upsertPromptVersion(input.agent, rendered.version, rendered.file_hash);

  const tierModel = { fast: config.llmFastModel, strong: config.llmStrongModel, judge: config.llmJudgeModel }[
    rendered.meta.model_tier
  ];
  const contractName = path.basename(rendered.meta.output_schema).replace(/\.schema\.json$/, '');
  const { provider: modelProvider, name: modelName } = splitModel(tierModel);

  const started = Date.now();
  let inputTokens = 0;
  let outputTokens = 0;
  let providerName = modelProvider;
  let user = rendered.user;
  let lastErrors: string[] = [];

  const record = (status: 'ok' | 'schema_invalid' | 'error', error: string | null): Promise<string> =>
    store.insertCall({
      run_id: input.run_id ?? null,
      lead_id: input.lead_id ?? null,
      agent: input.agent,
      provider: providerName,
      model: modelName,
      prompt_version: rendered.version,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      // Replayed calls spend nothing, whatever tokens the fixture recorded.
      cost_usd:
        providerName === 'replay' ? 0 : computeCost(pricing, tierModel, inputTokens, outputTokens).cost_usd,
      latency_ms: Date.now() - started,
      status,
      error,
    });

  for (let attempt = 1; attempt <= 2; attempt++) {
    let res;
    try {
      res = await provider.generate({
        model: tierModel,
        system: rendered.system,
        user,
        temperature: rendered.meta.temperature,
      });
    } catch (err) {
      const message = (err as Error).message;
      const call_id = await record('error', message);
      const status = err instanceof NotConfigured ? 501 : 502;
      return { status, body: { error: 'provider_error', message, call_id } };
    }
    inputTokens += res.input_tokens;
    outputTokens += res.output_tokens;
    providerName = res.provider ?? providerName;

    const parsed = parseJson(res.text);
    if (parsed.ok) {
      const v = contracts.validate(contractName, parsed.value);
      if (v.valid) {
        const call_id = await record('ok', null);
        return { status: 200, body: { output: parsed.value, call_id } };
      }
      lastErrors = v.errors;
    } else {
      lastErrors = [parsed.error];
    }
    if (attempt === 1) {
      user = `${rendered.user}\n\nYour previous reply failed validation against the output schema:\n${lastErrors
        .map((e) => `- ${e}`)
        .join('\n')}\nReturn corrected JSON only.`;
    }
  }

  const call_id = await record('schema_invalid', lastErrors.join('; ').slice(0, 1000));
  return { status: 422, body: { error: 'schema_invalid', errors: lastErrors, call_id } };
}
