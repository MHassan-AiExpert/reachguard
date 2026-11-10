import { describe, expect, it } from 'vitest';
import { signApprovalCallback, verifyApprovalCallback } from '../src/lib/approval-token.js';
import { buildServer } from '../src/server.js';
import { authHeaders, testConfig } from './helpers.js';

const ID = '0b6f1c1e-7c1a-4a45-9d3e-2f1f6f1a9e11';
const SECRET = 'whsec';

describe('approval callback data', () => {
  it('fits Telegram callback_data (64 bytes) for every action', () => {
    for (const a of ['approve', 'edit', 'reject'] as const) {
      expect(Buffer.byteLength(signApprovalCallback(ID, a, SECRET))).toBeLessThanOrEqual(64);
    }
  });
  it('round-trips each action', () => {
    for (const a of ['approve', 'edit', 'reject'] as const) {
      expect(verifyApprovalCallback(signApprovalCallback(ID, a, SECRET), SECRET)).toEqual({ approval_id: ID, action: a });
    }
  });
  it('rejects a tampered action, id or signature', () => {
    const d = signApprovalCallback(ID, 'reject', SECRET);
    const [id, , sig] = d.split(':') as [string, string, string];
    expect(verifyApprovalCallback(`${id}:a:${sig}`, SECRET)).toBeNull();
    expect(verifyApprovalCallback(`${ID.replace('0b', '0c')}:r:${sig}`, SECRET)).toBeNull();
    expect(verifyApprovalCallback(`${id}:r:${'0'.repeat(sig.length)}`, SECRET)).toBeNull();
  });
  it('rejects a signature made with another secret and garbage input', () => {
    expect(verifyApprovalCallback(signApprovalCallback(ID, 'approve', 'other'), SECRET)).toBeNull();
    for (const bad of ['', 'x', 'a:b', `${ID}:z:abc`, 'x'.repeat(500)]) expect(verifyApprovalCallback(bad, SECRET)).toBeNull();
  });
});

describe('approval routes', () => {
  const app = buildServer({ config: testConfig() });
  it('signs all three callbacks and verifies them', async () => {
    const s = await app.inject({ method: 'POST', url: '/v1/approvals/sign', headers: authHeaders, payload: { approval_id: ID } });
    expect(s.statusCode).toBe(200);
    const body = s.json() as { approve: string; edit: string; reject: string };
    const v = await app.inject({ method: 'POST', url: '/v1/approvals/verify', headers: authHeaders, payload: { data: body.edit } });
    expect(v.json()).toEqual({ valid: true, approval_id: ID, action: 'edit' });
  });
  it('reports a bad callback as invalid without failing', async () => {
    const v = await app.inject({ method: 'POST', url: '/v1/approvals/verify', headers: authHeaders, payload: { data: `${ID}:a:deadbeef` } });
    expect(v.statusCode).toBe(200);
    expect(v.json()).toEqual({ valid: false });
  });
  it('rejects a non-uuid approval id', async () => {
    const s = await app.inject({ method: 'POST', url: '/v1/approvals/sign', headers: authHeaders, payload: { approval_id: 'nope' } });
    expect(s.statusCode).toBe(400);
  });
});
