import { NotConfigured } from '../../lib/errors.js';
import { splitModel, type LlmProvider } from './types.js';

interface OpenAiResponse {
  choices?: { message?: { content?: string | null } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export function createOpenAiProvider(apiKey: string, fetchImpl: typeof fetch = fetch): LlmProvider {
  return {
    async generate(req) {
      if (!apiKey) throw new NotConfigured('OPENAI_API_KEY');
      const { name } = splitModel(req.model);
      const res = await fetchImpl('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: name,
          temperature: req.temperature,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: req.system },
            { role: 'user', content: req.user },
          ],
        }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) {
        const detail = (await res.text()).slice(0, 200);
        throw new Error(`OpenAI request failed with status ${res.status}: ${detail}`);
      }
      const json = (await res.json()) as OpenAiResponse;
      const text = json.choices?.[0]?.message?.content;
      if (!text) throw new Error('OpenAI returned no text');
      return {
        text,
        input_tokens: json.usage?.prompt_tokens ?? 0,
        output_tokens: json.usage?.completion_tokens ?? 0,
        provider: 'openai',
      };
    },
  };
}
