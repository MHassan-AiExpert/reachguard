import { randomUUID } from 'node:crypto';
import nodemailer from 'nodemailer';
import { describe, expect, it } from 'vitest';
import { createSender, NotConfigured } from '../src/adapters/sender/index.js';
import { createMailpitSender, toMailOptions } from '../src/adapters/sender/mailpit.js';
import { buildMessage } from '../src/lib/message.js';
import { testConfig } from './helpers.js';

const cfg = {
  publicBaseUrl: 'https://rg.example.com',
  unsubscribeSecret: 's',
  senderPhysicalAddress: 'Acme Ltd, 1 Main St, Lahore',
};

describe('mailpit sender', () => {
  it('renders a plain text MIME message with unsubscribe and threading headers, and returns the Message-ID', async () => {
    const transport = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'unix' });
    const sender = createMailpitSender(transport);
    const sendId = randomUUID();
    const msg = buildMessage(
      {
        send_id: sendId,
        step: 2,
        subject: null,
        body: 'Following up. Any thoughts?',
        thread: { subject: 'first subject', message_ids: ['<one@mail.reachguard.example>'] },
      },
      { id: randomUUID(), email: 'jane@prospect.example' },
      { email: 'muhammad@mail.reachguard.example', display_name: 'Muhammad Hassan' },
      cfg,
    );
    const res = await sender.send(msg);
    expect(res.provider_message_id).toBe(`<${sendId}@mail.reachguard.example>`);
    const rendered = (await transport.sendMail(toMailOptions(msg))) as unknown as { message: Buffer };
    // Long headers are folded onto continuation lines (valid MIME); unfold them before matching.
    const raw = rendered.message.toString().replace(/\n[ \t]+/g, ' ');
    expect(raw).toMatch(/^List-Unsubscribe-Post: List-Unsubscribe=One-Click$/m);
    expect(raw).toMatch(/^List-Unsubscribe: <https:\/\/rg\.example\.com\/u\//m);
    expect(raw).toMatch(/^In-Reply-To: <one@mail\.reachguard\.example>$/m);
    expect(raw).toMatch(/^Subject: first subject$/m);
    expect(raw).toMatch(/^Content-Type: text\/plain/m);
    expect(raw).not.toMatch(/text\/html/);
    expect(raw).toContain('Acme Ltd, 1 Main St, Lahore');
  });

  it('throws when the transport fails so the caller can retry', async () => {
    const sender = createMailpitSender({
      sendMail: async () => Promise.reject(new Error('smtp down')),
    } as never);
    await expect(
      sender.send(
        buildMessage(
          { send_id: randomUUID(), step: 1, subject: 's', body: 'b' },
          { id: randomUUID(), email: 'a@b.example' },
          { email: 'x@y.example' },
          cfg,
        ),
      ),
    ).rejects.toThrow('smtp down');
  });
});

describe('createSender', () => {
  it('uses mailpit in sandbox and the smartlead stub in live mode', async () => {
    expect(createSender(testConfig({ mode: 'sandbox' })).name).toBe('mailpit');
    const live = createSender(testConfig({ mode: 'live' }));
    expect(live.name).toBe('smartlead');
    const msg = buildMessage(
      { send_id: randomUUID(), step: 1, subject: 's', body: 'b' },
      { id: randomUUID(), email: 'a@b.example' },
      { email: 'x@y.example' },
      cfg,
    );
    await expect(live.send(msg)).rejects.toBeInstanceOf(NotConfigured);
  });
});

describe('sandbox sender safety', () => {
  it('refuses to deliver to an SMTP host that is not a local sink', () => {
    expect(() => createSender(testConfig({ mode: 'sandbox', smtpHost: 'smtp.real-relay.net' }))).toThrow(/sandbox.*SMTP/i);
  });
  it.each(['mailpit', 'localhost', '127.0.0.1'])('accepts the local sink %s', (host) => {
    expect(() => createSender(testConfig({ mode: 'sandbox', smtpHost: host }))).not.toThrow();
  });
});
