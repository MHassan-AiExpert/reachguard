import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { signUnsubscribeToken, verifyUnsubscribeToken } from '../src/lib/tokens.js';

const SECRET = 'unsub-secret';

describe('unsubscribe tokens', () => {
  it('round trips a lead id and is URL safe', () => {
    const id = randomUUID();
    const token = signUnsubscribeToken(id, SECRET);
    expect(token).toMatch(/^[A-Za-z0-9_.-]+$/);
    expect(verifyUnsubscribeToken(token, SECRET)).toBe(id);
  });

  it('is deterministic for the same lead and secret', () => {
    const id = randomUUID();
    expect(signUnsubscribeToken(id, SECRET)).toBe(signUnsubscribeToken(id, SECRET));
  });

  it('rejects a token signed with another secret', () => {
    expect(verifyUnsubscribeToken(signUnsubscribeToken(randomUUID(), 'other'), SECRET)).toBeNull();
  });

  it('rejects a tampered signature or a swapped lead id', () => {
    const a = signUnsubscribeToken(randomUUID(), SECRET);
    const b = signUnsubscribeToken(randomUUID(), SECRET);
    const [idA, sigA] = a.split('.') as [string, string];
    const [idB] = b.split('.') as [string, string];
    expect(
      verifyUnsubscribeToken(`${idA}.${sigA.slice(0, -1)}${sigA.endsWith('A') ? 'B' : 'A'}`, SECRET),
    ).toBeNull();
    expect(verifyUnsubscribeToken(`${idB}.${sigA}`, SECRET)).toBeNull();
  });

  it.each(['', 'abc', 'a.b.c', '.', 'x.'.repeat(50), 'A'.repeat(5000), '../../etc/passwd', '%00.%00'])(
    'rejects malformed token %j without throwing',
    (t) => {
      expect(verifyUnsubscribeToken(t, SECRET)).toBeNull();
    },
  );

  it('refuses to sign a value that is not a UUID', () => {
    expect(() => signUnsubscribeToken('not-a-uuid', SECRET)).toThrow();
  });
});
