import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

export class MissingVariable extends Error {
  constructor(public readonly variable: string) {
    super(`Missing prompt variable "${variable}"`);
    this.name = 'MissingVariable';
  }
}

export class UnknownAgent extends Error {
  constructor(public readonly agent: string) {
    super(`Unknown agent "${agent}"`);
    this.name = 'UnknownAgent';
  }
}

export type ModelTier = 'fast' | 'strong' | 'judge';

export interface PromptMeta {
  agent: string;
  version: string;
  model_tier: ModelTier;
  temperature: number;
  output_schema: string;
}

export interface LoadedPrompt {
  meta: PromptMeta;
  systemTemplate: string;
  userTemplate: string;
  /** SHA-256 of the prompt file; recorded in prompt_versions. */
  file_hash: string;
}

export interface RenderedPrompt {
  system: string;
  user: string;
  text: string;
  version: string;
  /** SHA-256 of the rendered text; the replay fixture key. */
  hash: string;
  meta: PromptMeta;
  file_hash: string;
}

export interface PromptStore {
  load(agent: string): LoadedPrompt;
  render(agent: string, variables: Record<string, unknown>): RenderedPrompt;
}

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

export function renderedText(system: string, user: string): string {
  return `SYSTEM\n${system}\n\nUSER\n${user}`;
}

export function promptHash(system: string, user: string): string {
  return sha256(renderedText(system, user));
}

function parsePrompt(agent: string, raw: string): LoadedPrompt {
  const fm = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw);
  if (!fm) throw new Error(`Prompt "${agent}" has no front matter`);
  const fields: Record<string, string> = {};
  for (const line of (fm[1] as string).split('\n')) {
    const m = /^([a-z_]+):\s*(.*)$/.exec(line.trim());
    if (m) fields[m[1] as string] = (m[2] as string).trim();
  }
  const tier = fields.model_tier;
  if (tier !== 'fast' && tier !== 'strong' && tier !== 'judge')
    throw new Error(`Prompt "${agent}" has an invalid model_tier`);
  const temperature = Number(fields.temperature);
  if (!fields.version || !fields.output_schema || Number.isNaN(temperature)) {
    throw new Error(`Prompt "${agent}" front matter is incomplete`);
  }
  const body = /^SYSTEM\n([\s\S]*?)\n\nUSER\n([\s\S]*)$/.exec((fm[2] as string).replace(/\s+$/, ''));
  if (!body) throw new Error(`Prompt "${agent}" must contain SYSTEM and USER sections`);
  return {
    meta: {
      agent: fields.agent ?? agent,
      version: fields.version,
      model_tier: tier,
      temperature,
      output_schema: fields.output_schema,
    },
    systemTemplate: body[1] as string,
    userTemplate: body[2] as string,
    file_hash: sha256(raw),
  };
}

// Variable values are data. Neutralise anything that could open or close an <untrusted_*> region.
function sanitize(value: string): string {
  return value.replace(/<(\/?)untrusted/gi, '&lt;$1untrusted');
}

function stringify(name: string, value: unknown): string {
  if (value === undefined) throw new MissingVariable(name);
  if (value === null) return '';
  if (typeof value === 'string') return sanitize(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return sanitize(JSON.stringify(value));
}

function fill(template: string, scope: Record<string, unknown>, fallback: Record<string, unknown>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_m, name: string) =>
    stringify(name, name in scope ? scope[name] : fallback[name]),
  );
}

function renderTemplate(template: string, vars: Record<string, unknown>): string {
  const expanded = template.replace(
    /\{\{#each (\w+)\}\}\n?([\s\S]*?)\{\{\/each\}\}\n?/g,
    (_m, name: string, block: string) => {
      const list = vars[name];
      if (!Array.isArray(list)) throw new MissingVariable(name);
      return list
        .map((item) =>
          fill(block, (item && typeof item === 'object' ? item : {}) as Record<string, unknown>, vars),
        )
        .join('');
    },
  );
  return fill(expanded, vars, {});
}

export function createPromptStore(dir: string): PromptStore {
  const cache = new Map<string, LoadedPrompt>();
  const load = (agent: string): LoadedPrompt => {
    if (!/^[a-z0-9-]+$/.test(agent)) throw new UnknownAgent(agent);
    const hit = cache.get(agent);
    if (hit) return hit;
    let raw: string;
    try {
      raw = readFileSync(path.join(dir, `${agent}.md`), 'utf8');
    } catch {
      throw new UnknownAgent(agent);
    }
    const parsed = parsePrompt(agent, raw);
    cache.set(agent, parsed);
    return parsed;
  };
  return {
    load,
    render(agent, variables) {
      const p = load(agent);
      const system = renderTemplate(p.systemTemplate, variables);
      const user = renderTemplate(p.userTemplate, variables);
      const text = renderedText(system, user);
      return {
        system,
        user,
        text,
        version: p.meta.version,
        hash: sha256(text),
        meta: p.meta,
        file_hash: p.file_hash,
      };
    },
  };
}
