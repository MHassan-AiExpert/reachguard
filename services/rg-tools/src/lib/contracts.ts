import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Ajv2020, type ErrorObject } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';

// ajv-formats is CommonJS: under NodeNext the callable plugin lives on `.default`.
const addFormats = addFormatsModule.default;

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export interface ContractRegistry {
  has(name: string): boolean;
  names(): string[];
  validate(name: string, data: unknown): ValidationResult;
}

export function loadContracts(dir: string): ContractRegistry {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  const validators = new Map<string, ReturnType<typeof ajv.compile>>();

  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.schema.json')) continue;
    const name = file.replace('.schema.json', '');
    const schema = JSON.parse(readFileSync(path.join(dir, file), 'utf8')) as object;
    validators.set(name, ajv.compile(schema));
  }

  return {
    has: (name) => validators.has(name),
    names: () => [...validators.keys()],
    validate(name, data) {
      const v = validators.get(name);
      if (!v) return { valid: false, errors: [`unknown contract: ${name}`] };
      const valid = v(data) as boolean;
      const errors = valid
        ? []
        : (v.errors ?? []).map(
            (e: ErrorObject) =>
              `${e.instancePath || '/'} ${e.message ?? 'invalid'}${
                e.params && 'missingProperty' in e.params ? ` (${String(e.params.missingProperty)})` : ''
              }`,
          );
      return { valid, errors };
    },
  };
}
