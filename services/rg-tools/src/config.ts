import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type Mode = 'sandbox' | 'live';

export interface Config {
  mode: Mode;
  liveSendEnabled: boolean;
  port: number;
  apiKey: string;
  webhookSecret: string;
  unsubscribeSecret: string;
  publicBaseUrl: string;
  senderPhysicalAddress: string;
  bookingLink: string;
  databaseUrl: string;
  redisUrl: string;
  contractsDir: string;
  promptsDir: string;
  configDir: string;
  sandboxSitesDir: string;
  llmMode: 'live' | 'replay';
  llmFastModel: string;
  llmStrongModel: string;
  llmJudgeModel: string;
  llmDailyBudgetUsd: number;
  llmFixturesDir: string;
  geminiApiKey: string;
  openaiApiKey: string;
  smtpHost: string;
  smtpPort: number;
  eventsWebhookUrl: string;
  /** Sandbox compresses the gap between sequence steps to this many minutes. */
  sandboxStepDelayMinutes: number;
  intakeWebhookUrl: string;
  sandboxDataDir: string;
  dkimSelector: string;
}

const here = path.dirname(fileURLToPath(import.meta.url));
// Repo root when running from source (src -> rg-tools -> services -> repo). Docker sets RG_ROOT=/app.
function defaultRoot(): string {
  return path.resolve(here, '../../..');
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const v = env[key];
  if (!v) throw new Error(`Missing required environment variable ${key}`);
  return v;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // No default: forgetting MODE must stop the service, not quietly select the mode that allows data resets.
  const mode = required(env, 'MODE') as Mode;
  if (mode !== 'sandbox' && mode !== 'live') throw new Error(`MODE must be sandbox or live, got ${mode}`);
  const root = env.RG_ROOT ?? defaultRoot();
  return {
    mode,
    liveSendEnabled: env.LIVE_SEND_ENABLED === 'true',
    port: Number(env.PORT ?? 8080),
    apiKey: required(env, 'RG_TOOLS_API_KEY'),
    webhookSecret: required(env, 'RG_WEBHOOK_SECRET'),
    unsubscribeSecret: required(env, 'RG_UNSUBSCRIBE_SECRET'),
    publicBaseUrl: env.RG_PUBLIC_BASE_URL ?? 'http://localhost:8080',
    senderPhysicalAddress: required(env, 'SENDER_PHYSICAL_ADDRESS'),
    bookingLink: env.BOOKING_LINK ?? '',
    databaseUrl: env.DATABASE_URL ?? '',
    redisUrl: env.REDIS_URL ?? '',
    contractsDir: env.CONTRACTS_DIR ?? path.join(root, 'contracts'),
    promptsDir: env.PROMPTS_DIR ?? path.join(root, 'prompts'),
    configDir: env.CONFIG_DIR ?? path.join(root, 'config'),
    sandboxSitesDir: env.SANDBOX_SITES_DIR ?? path.join(root, 'sandbox/sites'),
    llmMode: env.LLM_MODE === 'replay' ? 'replay' : 'live',
    llmFastModel: env.LLM_FAST_MODEL ?? 'google:gemini-2.5-flash',
    llmStrongModel: env.LLM_STRONG_MODEL ?? 'google:gemini-2.5-pro',
    llmJudgeModel: env.LLM_JUDGE_MODEL ?? env.LLM_STRONG_MODEL ?? 'google:gemini-2.5-pro',
    llmDailyBudgetUsd: Number(env.LLM_DAILY_BUDGET_USD ?? 5),
    llmFixturesDir: env.LLM_FIXTURES_DIR ?? path.join(root, 'services/rg-tools/test/fixtures/llm'),
    geminiApiKey: env.GEMINI_API_KEY ?? '',
    openaiApiKey: env.OPENAI_API_KEY ?? '',
    smtpHost: env.SMTP_HOST ?? 'localhost',
    smtpPort: Number(env.SMTP_PORT ?? 1025),
    eventsWebhookUrl: env.RG_EVENTS_WEBHOOK_URL ?? 'http://n8n:5678/webhook/rg/events',
    sandboxStepDelayMinutes: Number(env.SANDBOX_STEP_DELAY_MINUTES ?? 3),
    intakeWebhookUrl: env.RG_INTAKE_WEBHOOK_URL ?? 'http://n8n:5678/webhook/rg/intake',
    sandboxDataDir: env.SANDBOX_DATA_DIR ?? path.join(root, 'sandbox'),
    dkimSelector: env.DKIM_SELECTOR ?? 'rg',
  };
}
