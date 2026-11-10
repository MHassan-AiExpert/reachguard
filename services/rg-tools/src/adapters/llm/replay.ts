import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promptHash } from '../../lib/prompts.js';
import type { LlmProvider } from './types.js';

export class ReplayMiss extends Error {
  constructor(public readonly hash: string) {
    super(`No replay fixture for prompt hash ${hash}`);
    this.name = 'ReplayMiss';
  }
}

interface Fixture {
  text: string;
  input_tokens?: number;
  output_tokens?: number;
}

export function createReplayProvider(dir: string): LlmProvider {
  return {
    async generate(req) {
      const hash = promptHash(req.system, req.user);
      let raw: string;
      try {
        raw = await readFile(path.join(dir, `${hash}.json`), 'utf8');
      } catch (err) {
        if ((err as { code?: string }).code === 'ENOENT') throw new ReplayMiss(hash);
        throw err;
      }
      const f = JSON.parse(raw) as Fixture;
      return {
        text: f.text,
        input_tokens: f.input_tokens ?? 0,
        output_tokens: f.output_tokens ?? 0,
        provider: 'replay',
      };
    },
  };
}
