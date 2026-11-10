import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { Config } from '../src/config.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(here, '../../..');

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    mode: 'sandbox',
    liveSendEnabled: false,
    port: 0,
    apiKey: 'test-key',
    webhookSecret: 'whsec',
    unsubscribeSecret: 'unsub-secret',
    publicBaseUrl: 'http://localhost:8080',
    senderPhysicalAddress: 'Test Co, 1 Test St, Lahore, Pakistan',
    bookingLink: 'https://cal.com/example/intro',
    databaseUrl: '',
    redisUrl: '',
    contractsDir: path.join(repoRoot, 'contracts'),
    promptsDir: path.join(repoRoot, 'prompts'),
    configDir: path.join(repoRoot, 'config'),
    sandboxSitesDir: path.join(repoRoot, 'sandbox/sites'),
    llmMode: 'replay',
    llmFastModel: 'google:gemini-2.5-flash',
    llmStrongModel: 'google:gemini-2.5-pro',
    llmJudgeModel: 'google:gemini-2.5-pro',
    llmDailyBudgetUsd: 5,
    ...overrides,
  };
}

export const authHeaders = { 'x-rg-key': 'test-key' };
