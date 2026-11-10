import dns from 'node:dns/promises';

export interface MxRecord {
  exchange: string;
  priority: number;
}

export interface DnsResolver {
  resolveMx(domain: string): Promise<MxRecord[]>;
  resolve4(domain: string): Promise<string[]>;
}

export interface MxResult {
  has_mx: boolean;
  hosts: string[];
}

export interface MxCache {
  get(key: string): MxResult | undefined;
  set(key: string, value: MxResult): void;
}

export function createMemoryCache(ttlMs = 60 * 60 * 1000, now: () => number = Date.now): MxCache {
  const store = new Map<string, { value: MxResult; expires: number }>();
  return {
    get(key) {
      const hit = store.get(key);
      if (!hit) return undefined;
      if (hit.expires <= now()) {
        store.delete(key);
        return undefined;
      }
      return hit.value;
    },
    set(key, value) {
      store.set(key, { value, expires: now() + ttlMs });
    },
  };
}

export const systemResolver: DnsResolver = {
  resolveMx: (d) => dns.resolveMx(d),
  resolve4: (d) => dns.resolve4(d),
};

const NO_ANSWER = new Set(['ENODATA', 'ENOTFOUND', 'NXDOMAIN']);

function isNoAnswer(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code !== undefined && NO_ANSWER.has(code);
}

export async function mxLookup(
  rawDomain: string,
  deps: { resolver: DnsResolver; cache: MxCache },
): Promise<MxResult> {
  const domain = rawDomain.trim().toLowerCase().replace(/\.$/, '');
  const cached = deps.cache.get(domain);
  if (cached) return cached;

  let result: MxResult;
  let mx: MxRecord[] = [];
  try {
    mx = await deps.resolver.resolveMx(domain);
  } catch (err) {
    if (!isNoAnswer(err)) throw err;
  }

  const hosts = mx
    .filter((r) => r.exchange !== '' && r.exchange !== '.')
    .sort((a, b) => a.priority - b.priority)
    .map((r) => r.exchange.toLowerCase().replace(/\.$/, ''));

  if (hosts.length > 0) {
    result = { has_mx: true, hosts };
  } else if (mx.length > 0) {
    // Null MX (RFC 7505): the domain explicitly accepts no mail.
    result = { has_mx: false, hosts: [] };
  } else {
    // RFC 5321: no MX means fall back to the address record.
    let addrs: string[] = [];
    try {
      addrs = await deps.resolver.resolve4(domain);
    } catch (err) {
      if (!isNoAnswer(err)) throw err;
    }
    result = addrs.length > 0 ? { has_mx: true, hosts: [domain] } : { has_mx: false, hosts: [] };
  }
  deps.cache.set(domain, result);
  return result;
}
