import dns from 'node:dns';
import { BlockList, isIP } from 'node:net';
import { FetchError } from './errors.js';

const blocked = new BlockList();
const v4: [string, number][] = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];
for (const [net, prefix] of v4) blocked.addSubnet(net, prefix, 'ipv4');
const v6: [string, number][] = [
  ['::', 128],
  ['::1', 128],
  ['100::', 64],
  ['2001::', 32],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['64:ff9b::', 96],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
];
for (const [net, prefix] of v6) blocked.addSubnet(net, prefix, 'ipv6');

/** True when the address must never be fetched. Anything that is not an IP literal fails closed. */
export function isBlockedAddress(raw: string): boolean {
  const ip = raw.replace(/^\[|\]$/g, '').split('%')[0] ?? '';
  const family = isIP(ip);
  if (family === 0) return true;
  return blocked.check(ip, family === 4 ? 'ipv4' : 'ipv6');
}

const BLOCKED_SUFFIXES = ['.localhost', '.local', '.internal', '.localdomain', '.home.arpa'];

export function isBlockedHostname(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  return h === 'localhost' || BLOCKED_SUFFIXES.some((s) => h.endsWith(s));
}

type LookupCallback = (
  err: Error | null,
  address?: string | { address: string; family: number }[],
  family?: number,
) => void;

/**
 * DNS lookup used when connecting. Because the check runs on the addresses the socket will actually use,
 * a hostname that resolves to a public address during validation and a private one at connect time
 * (DNS rebinding) is still refused.
 */
export function guardedLookup(
  hostname: string,
  options: { all?: boolean; family?: number },
  callback: LookupCallback,
): void {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err);
    const list = addresses as dns.LookupAddress[];
    if (list.length === 0 || list.some((a) => isBlockedAddress(a.address))) {
      return callback(new FetchError('blocked_address', `Address for ${hostname} is blocked`));
    }
    if (options.all) return callback(null, list);
    const first = list[0] as dns.LookupAddress;
    return callback(null, first.address, first.family);
  });
}
