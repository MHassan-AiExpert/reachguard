import { describe, expect, it } from 'vitest';
import { createGeminiProvider } from '../src/adapters/llm/gemini.js';
import { createLlmProvider } from '../src/adapters/llm/index.js';
import { createOpenAiProvider } from '../src/adapters/llm/openai.js';
import { NotConfigured } from '../src/lib/errors.js';
import { testConfig } from './helpers.js';

function fakeFetch(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const REQ = { model: 'google:gemini-2.5-flash', system: 'sys', user: 'usr', temperature: 0.2 };

describe('gemini provider', () => {
  it('sends the key in a header (never the URL) and requests JSON output', async () => {
    const f = fakeFetch(200, {
      candidates: [{ content: { parts: [{ text: '{"a":' }, { text: '1}' }] } }],
      usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 7 },
    });
    const p = createGeminiProvider('KEY123', f.impl);
    const out = await p.generate(REQ);
    expect(out).toEqual({ text: '{"a":1}', input_tokens: 12, output_tokens: 7, provider: 'google' });
    const call = f.calls[0];
    expect(call?.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
    );
    expect(call?.url).not.toContain('KEY123');
    expect((call?.init.headers as Record<string, string>)['x-goog-api-key']).toBe('KEY123');
    const body = JSON.parse(String(call?.init.body));
    expect(body.systemInstruction.parts[0].text).toBe('sys');
    expect(body.contents[0].parts[0].text).toBe('usr');
    expect(body.generationConfig).toMatchObject({ temperature: 0.2, responseMimeType: 'application/json' });
  });

  it('throws on a non-2xx response without leaking the key', async () => {
    const p = createGeminiProvider('KEY123', fakeFetch(429, { error: { message: 'quota' } }).impl);
    await expect(p.generate(REQ)).rejects.toThrow(/429/);
    await expect(p.generate(REQ)).rejects.not.toThrow(/KEY123/);
  });

  it('throws when the response has no text (blocked or empty)', async () => {
    const p = createGeminiProvider('K', fakeFetch(200, { candidates: [{ finishReason: 'SAFETY' }] }).impl);
    await expect(p.generate(REQ)).rejects.toThrow(/no text/i);
  });

  it('throws NotConfigured without an API key', async () => {
    await expect(createGeminiProvider('', fakeFetch(200, {}).impl).generate(REQ)).rejects.toBeInstanceOf(
      NotConfigured,
    );
  });
});

describe('openai provider', () => {
  it('uses bearer auth and json_object response format', async () => {
    const f = fakeFetch(200, {
      choices: [{ message: { content: '{"ok":true}' } }],
      usage: { prompt_tokens: 20, completion_tokens: 4 },
    });
    const out = await createOpenAiProvider('OKEY', f.impl).generate({ ...REQ, model: 'openai:gpt-x' });
    expect(out).toEqual({ text: '{"ok":true}', input_tokens: 20, output_tokens: 4, provider: 'openai' });
    const body = JSON.parse(String(f.calls[0]?.init.body));
    expect(body).toMatchObject({
      model: 'gpt-x',
      temperature: 0.2,
      response_format: { type: 'json_object' },
    });
    expect(body.messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'usr' },
    ]);
    expect((f.calls[0]?.init.headers as Record<string, string>).authorization).toBe('Bearer OKEY');
  });

  it('throws NotConfigured without an API key', async () => {
    await expect(createOpenAiProvider('', fakeFetch(200, {}).impl).generate(REQ)).rejects.toBeInstanceOf(
      NotConfigured,
    );
  });
});

describe('createLlmProvider routing', () => {
  it('rejects an unknown provider prefix', async () => {
    const p = createLlmProvider(testConfig({ llmMode: 'live' }));
    await expect(p.generate({ ...REQ, model: 'acme:x' })).rejects.toThrow(/unknown llm provider/i);
  });
});
