import { NotConfigured } from '../../lib/errors.js';
import { splitModel, type LlmProvider } from './types.js';

const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

interface GeminiResponse {
  candidates?: { content?: { parts?: { text?: string }[] } }[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

export function createGeminiProvider(apiKey: string, fetchImpl: typeof fetch = fetch): LlmProvider {
  return {
    async generate(req) {
      if (!apiKey) throw new NotConfigured('GEMINI_API_KEY');
      const { name } = splitModel(req.model);
      const res = await fetchImpl(`${BASE}/${name}:generateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: req.system }] },
          contents: [{ role: 'user', parts: [{ text: req.user }] }],
          generationConfig: { temperature: req.temperature, responseMimeType: 'application/json' },
        }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) {
        const detail = (await res.text()).slice(0, 200);
        throw new Error(`Gemini request failed with status ${res.status}: ${detail}`);
      }
      const json = (await res.json()) as GeminiResponse;
      const text = (json.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('');
      if (!text) throw new Error('Gemini returned no text (blocked or empty response)');
      return {
        text,
        input_tokens: json.usageMetadata?.promptTokenCount ?? 0,
        output_tokens: json.usageMetadata?.candidatesTokenCount ?? 0,
        provider: 'google',
      };
    },
  };
}
