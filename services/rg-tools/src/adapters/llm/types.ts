export interface LlmRequest {
  /** Provider-qualified model id, e.g. "google:gemini-2.5-flash". */
  model: string;
  system: string;
  user: string;
  temperature: number;
}

export interface LlmResponse {
  text: string;
  input_tokens: number;
  output_tokens: number;
  /** Set by adapters that know their own name; the gateway falls back to the model prefix. */
  provider?: string;
}

export interface LlmProvider {
  generate(req: LlmRequest): Promise<LlmResponse>;
}

export function splitModel(model: string): { provider: string; name: string } {
  const i = model.indexOf(':');
  return i === -1
    ? { provider: 'unknown', name: model }
    : { provider: model.slice(0, i), name: model.slice(i + 1) };
}
