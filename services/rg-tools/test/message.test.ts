import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildMessage, type MessageConfig } from '../src/lib/message.js';
import { verifyUnsubscribeToken } from '../src/lib/tokens.js';

const cfg: MessageConfig = {
  publicBaseUrl: 'https://rg.example.com/',
  unsubscribeSecret: 'unsub-secret',
  senderPhysicalAddress: 'Acme Ltd, 1 Main St, Lahore, Pakistan',
};
const lead = { id: randomUUID(), email: 'jane@acme-prospect.example', first_name: 'Jane' };
const inbox = { email: 'muhammad@mail.reachguard.example', display_name: 'Muhammad Hassan' };
const draft = (over: Partial<Parameters<typeof buildMessage>[0]> = {}) => ({
  send_id: randomUUID(),
  step: 1,
  subject: 'quick question about atlas',
  body: 'Hi Jane,\nSaw the Atlas launch at https://acme-prospect.example/news. Worth a chat?\nMuhammad',
  ...over,
});

describe('buildMessage', () => {
  it('adds both RFC 8058 headers, a signed visible unsubscribe link and the physical address', () => {
    const m = buildMessage(draft(), lead, inbox, cfg);
    const url = /https:\/\/rg\.example\.com\/u\/([A-Za-z0-9_.-]+)/.exec(
      m.headers['List-Unsubscribe'] as string,
    );
    expect(url).not.toBeNull();
    expect(verifyUnsubscribeToken(url?.[1] as string, cfg.unsubscribeSecret)).toBe(lead.id);
    expect(m.headers['List-Unsubscribe']).toMatch(
      /^<https:\/\/rg\.example\.com\/u\/.+>, <mailto:muhammad@mail\.reachguard\.example\?subject=unsubscribe>$/,
    );
    expect(m.headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    expect(m.text).toContain('Acme Ltd, 1 Main St, Lahore, Pakistan');
    expect(m.text).toContain(`https://rg.example.com/u/${url?.[1]}`);
    expect(m.text).not.toContain('//u/');
  });

  it('keeps the body untouched: no tracking pixel, no link rewriting', () => {
    const m = buildMessage(draft(), lead, inbox, cfg);
    expect(
      m.text.startsWith(
        'Hi Jane,\nSaw the Atlas launch at https://acme-prospect.example/news. Worth a chat?\nMuhammad',
      ),
    ).toBe(true);
    expect(m.text).not.toMatch(/<img|track|pixel/i);
    expect(m.headers['Content-Type']).toBe('text/plain; charset=utf-8');
  });

  it('sets From, To, Subject and a deterministic Message-ID on the sending domain', () => {
    const d = draft();
    const a = buildMessage(d, lead, inbox, cfg);
    const b = buildMessage(d, lead, inbox, cfg);
    expect(a.headers['Message-ID']).toBe(`<${d.send_id}@mail.reachguard.example>`);
    expect(a.headers['Message-ID']).toBe(b.headers['Message-ID']);
    expect(a.headers.From).toBe('"Muhammad Hassan" <muhammad@mail.reachguard.example>');
    expect(a.headers.To).toBe('jane@acme-prospect.example');
    expect(a.headers.Subject).toBe('quick question about atlas');
    expect(a.headers['In-Reply-To']).toBeUndefined();
    expect(a.headers.References).toBeUndefined();
  });

  it('threads follow-ups on the previous messages without adding a fake Re: prefix', () => {
    const m = buildMessage(
      draft({
        step: 3,
        subject: null,
        thread: { subject: 'quick question about atlas', message_ids: ['<one@d>', '<two@d>'] },
      }),
      lead,
      inbox,
      cfg,
    );
    expect(m.headers.Subject).toBe('quick question about atlas');
    expect(m.headers['In-Reply-To']).toBe('<two@d>');
    expect(m.headers.References).toBe('<one@d> <two@d>');
  });

  it('strips CR and LF from header values so a model-written subject cannot inject headers', () => {
    const m = buildMessage(
      draft({ subject: 'Hello\r\nBcc: evil@x.example' }),
      lead,
      { email: inbox.email, display_name: 'Eve"\r\nX: y' },
      cfg,
    );
    for (const [k, v] of Object.entries(m.headers)) expect(`${k}${v}`).not.toMatch(/[\r\n]/);
    expect(m.headers.Subject).toBe('Hello Bcc: evil@x.example');
    expect(m.headers.From).not.toContain('"Eve""');
  });

  it('falls back to the bare address when there is no display name', () => {
    expect(buildMessage(draft(), lead, { email: inbox.email }, cfg).headers.From).toBe(inbox.email);
  });

  it('normalises line endings in the body to LF', () => {
    expect(buildMessage(draft({ body: 'a\r\nb\rc' }), lead, inbox, cfg).text.startsWith('a\nb\nc')).toBe(
      true,
    );
  });

  it('refuses to build a message without a physical address (CAN-SPAM)', () => {
    expect(() => buildMessage(draft(), lead, inbox, { ...cfg, senderPhysicalAddress: '   ' })).toThrow(
      /physical address/i,
    );
  });

  it('uses the step 1 subject check: a missing subject on step 1 is an error', () => {
    expect(() => buildMessage(draft({ subject: null }), lead, inbox, cfg)).toThrow(/subject/i);
  });
});
