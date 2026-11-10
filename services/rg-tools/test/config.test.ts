import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const base = { RG_TOOLS_API_KEY: 'k', RG_WEBHOOK_SECRET: 'w', RG_UNSUBSCRIBE_SECRET: 'u', SENDER_PHYSICAL_ADDRESS: 'Test Co' };

describe('loadConfig MODE', () => {
  it('refuses to start when MODE is not set, so a live deployment cannot fall back to sandbox by omission', () => {
    expect(() => loadConfig({ ...base })).toThrow(/MODE/);
  });
  it('accepts sandbox and live explicitly', () => {
    expect(loadConfig({ ...base, MODE: 'sandbox' }).mode).toBe('sandbox');
    expect(loadConfig({ ...base, MODE: 'live' }).mode).toBe('live');
  });
});
