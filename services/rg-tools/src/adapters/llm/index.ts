import type { Config } from '../../config.js';
import { createGeminiProvider } from './gemini.js';
import { createOpenAiProvider } from './openai.js';
import { createReplayProvider } from './replay.js';
import { splitModel, type LlmProvider } from './types.js';

export * from './types.js';

export function createLlmProvider(config: Config): LlmProvider {
  if (config.llmMode === 'replay') return createReplayProvider(config.llmFixturesDir);
  const google = createGeminiProvider(config.geminiApiKey);
  const openai = createOpenAiProvider(config.openaiApiKey);
  return {
    generate(req) {
      switch (splitModel(req.model).provider) {
        case 'google':
          return google.generate(req);
        case 'openai':
          return openai.generate(req);
        default:
          return Promise.reject(new Error(`Unknown LLM provider in model "${req.model}"`));
      }
    },
  };
}
