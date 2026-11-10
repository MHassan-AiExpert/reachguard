import { describe, expect, it } from 'vitest';
import { guardedLookup, isBlockedAddress, isBlockedHostname } from '../src/lib/ssrf.js';

describe('isBlockedAddress', () => {
  it.each([
    '127.0.0.1',
    '127.255.255.254',
    '0.0.0.0',
    '10.0.0.5',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '224.0.0.1',
    '255.255.255.255',
    '::1',
    '::',
    'fe80::1',
    'fc00::1',
    'fd12:3456::1',
    '::ffff:127.0.0.1',
    '::ffff:10.1.2.3',
    '::ffff:169.254.169.254',
    'ff02::1',
  ])('blocks %s', (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });

  it.each([
    '8.8.8.8',
    '1.1.1.1',
    '93.184.216.34',
    '172.15.0.1',
    '172.32.0.1',
    '2606:4700:4700::1111',
    '::ffff:8.8.8.8',
  ])('allows public address %s', (ip) => {
    expect(isBlockedAddress(ip)).toBe(false);
  });

  it('fails closed on strings that are not IP addresses', () => {
    expect(isBlockedAddress('not-an-ip')).toBe(true);
    expect(isBlockedAddress('')).toBe(true);
  });
});

describe('isBlockedHostname', () => {
  it.each([
    'localhost',
    'foo.localhost',
    'metadata.google.internal',
    'printer.local',
    'db.internal',
    'x.localdomain',
  ])('blocks %s without resolving', (h) => {
    expect(isBlockedHostname(h)).toBe(true);
  });
  it('allows ordinary names', () => {
    expect(isBlockedHostname('example.com')).toBe(false);
    expect(isBlockedHostname('internal-tools.com')).toBe(false);
  });
});

describe('guardedLookup (connect-time guard against DNS rebinding)', () => {
  it('refuses a name that resolves to loopback', async () => {
    const err = await new Promise<Error | null>((resolve) => {
      guardedLookup('localhost', { all: true }, (e) => resolve(e));
    });
    expect(err).toBeTruthy();
    expect(err?.message).toMatch(/blocked/i);
  });
});
