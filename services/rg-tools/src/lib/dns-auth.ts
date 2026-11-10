import dns from 'node:dns/promises';

export interface TxtResolver {
  resolveTxt(name: string): Promise<string[][]>;
}

export const systemTxtResolver: TxtResolver = { resolveTxt: (n) => dns.resolveTxt(n) };

export interface DnsAuthResult {
  spf_ok: boolean;
  dkim_ok: boolean;
  dmarc_ok: boolean;
}

const NO_ANSWER = new Set(['ENODATA', 'ENOTFOUND', 'NXDOMAIN']);

/** TXT strings for a name, each record's chunks joined. A missing name is an empty list; any other failure throws. */
async function txtRecords(resolver: TxtResolver, name: string): Promise<string[]> {
  try {
    return (await resolver.resolveTxt(name)).map((chunks) => chunks.join(''));
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (code && NO_ANSWER.has(code)) return [];
    throw err;
  }
}

/**
 * SPF at the domain, DKIM at <selector>._domainkey, DMARC at _dmarc. A transient resolver error throws, because the
 * Guardian must not pause a healthy domain on a DNS blip.
 */
export async function checkDnsAuth(rawDomain: string, selector: string, resolver: TxtResolver): Promise<DnsAuthResult> {
  const domain = rawDomain.trim().toLowerCase().replace(/\.$/, '');
  const [root, dkim, dmarc] = await Promise.all([
    txtRecords(resolver, domain),
    txtRecords(resolver, `${selector}._domainkey.${domain}`),
    txtRecords(resolver, `_dmarc.${domain}`),
  ]);
  return {
    spf_ok: root.some((r) => /^v=spf1(\s|$)/i.test(r.trim())),
    dkim_ok: dkim.some((r) => /^v=DKIM1\b/i.test(r.trim()) && /\bp=[A-Za-z0-9+/=]+/.test(r)),
    dmarc_ok: dmarc.some((r) => /^v=DMARC1\b/i.test(r.trim())),
  };
}
