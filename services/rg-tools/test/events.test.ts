import { describe, expect, it } from 'vitest';
import { applyUnsubscribeRules, loadUnsubscribeRules, normalizeForRules } from '../src/lib/classify-rules.js';
import { buildServer } from '../src/server.js';
import { authHeaders, testConfig } from './helpers.js';

const rules = loadUnsubscribeRules(testConfig().configDir);
const hit = (body: string) => applyUnsubscribeRules(body, rules);

describe('applyUnsubscribeRules', () => {
  it.each([
    'stop',
    'STOP',
    'Stop.',
    'please remove me from your list',
    'Unsubscribe',
    'Take me off this list',
    'do not contact me again',
    "Don't email me anymore",
    'dejen de escribirme',
    'Por favor, dejen de escribirme.',
    'No me contacten más',
    'Quiero darme de baja',
    'Ne me contactez plus',
    'Merci de me désabonner',
    'Bitte entfernen Sie mich aus Ihrem Verteiler',
    'Bitte löschen Sie meine Daten',
    'Não me contate mais',
    'Smettete di scrivermi',
    'Sounds interesting, let us talk next week. Also, please stop emailing my colleague.',
    'Thanks! Remove me from this list but I would love a call about something else.',
  ])('flags an unsubscribe request: %s', (body) => {
    expect(hit(body)).toBe(true);
  });

  it.each([
    'Sounds great, can we talk Tuesday?',
    'Interested. Send pricing please.',
    'We use a bus stop near the office, see you there',
    'I am out of office until Monday',
    '',
    '   \n\t ',
  ])('does not flag: %j', (body) => {
    expect(hit(body)).toBe(false);
  });

  it('ignores the quoted copy of our own footer in a normal reply', () => {
    expect(
      hit(
        'Interested!\n\n> If you would rather not hear from me again, unsubscribe here: https://x/u/abc\n> Acme Ltd',
      ),
    ).toBe(false);
    expect(
      hit(
        'Interested!\n\nOn Tue, Mar 3, 2026 at 9:00 AM Jane <j@x.example> wrote:\nunsubscribe here: https://x/u/abc',
      ),
    ).toBe(false);
    expect(hit('----- Original Message -----\nTo unsubscribe click here')).toBe(false);
  });

  it('still catches a request written above the quoted text', () => {
    expect(hit('Please remove me.\n\n> Hi Jane, quick question about Atlas')).toBe(true);
  });

  it('handles an empty body and a 100,000 character body quickly and correctly', () => {
    const big = 'lorem ipsum dolor '.repeat(5600);
    expect(big.length).toBeGreaterThan(100_000);
    const t0 = Date.now();
    expect(hit(big)).toBe(false);
    expect(hit(`${big} please remove me`)).toBe(true);
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it('keeps every configured phrase in the normalised form the matcher compares against', () => {
    for (const p of rules.phrases) expect(normalizeForRules(p)).toBe(p);
    expect(rules.phrases.length).toBeGreaterThan(40);
  });
});

describe('POST /v1/events/normalize', () => {
  const server = buildServer({ config: testConfig() });
  const post = (payload: object) =>
    server.inject({ method: 'POST', url: '/v1/events/normalize', headers: authHeaders, payload });
  const base = {
    provider: 'sandbox',
    payload: {
      provider_event_id: 'evt-1',
      type: 'reply',
      lead_id: '3f2b8e5c-1d4a-4c6e-9a7b-0e1f2a3b4c5d',
      body: 'Please remove me',
    },
  };

  it('normalizes a sandbox reply and reports the unsubscribe rule hit', async () => {
    const res = await post(base);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      provider_event_id: 'evt-1',
      type: 'reply',
      lead_id: base.payload.lead_id,
      body: 'Please remove me',
      unsubscribe_rule_hit: true,
    });
    expect(typeof res.json().occurred_at).toBe('string');
  });

  it('accepts an empty reply body and a 100,000 character body without error', async () => {
    const empty = await post({ ...base, payload: { ...base.payload, body: '' } });
    expect(empty.statusCode).toBe(200);
    expect(empty.json().unsubscribe_rule_hit).toBe(false);
    const big = await post({ ...base, payload: { ...base.payload, body: 'x '.repeat(50_000) } });
    expect(big.statusCode).toBe(200);
    expect(big.json().unsubscribe_rule_hit).toBe(false);
  });

  it('flags an unsubscribe request hidden in an otherwise positive Spanish reply', async () => {
    const res = await post({
      ...base,
      payload: {
        ...base.payload,
        body: 'Me interesa mucho la propuesta, pero por favor dejen de escribirme a este correo.',
      },
    });
    expect(res.json().unsubscribe_rule_hit).toBe(true);
  });

  it('does not compute the rule for non-reply events', async () => {
    const res = await post({
      provider: 'sandbox',
      payload: { provider_event_id: 'e2', type: 'bounce_hard', lead_id: base.payload.lead_id },
    });
    expect(res.json()).toMatchObject({ type: 'bounce_hard', unsubscribe_rule_hit: false });
  });

  it('rejects unknown types, missing ids and missing provider event ids', async () => {
    expect((await post({ ...base, payload: { ...base.payload, type: 'opened' } })).statusCode).toBe(400);
    expect(
      (await post({ provider: 'sandbox', payload: { provider_event_id: 'e', type: 'reply' } })).statusCode,
    ).toBe(400);
    expect(
      (await post({ provider: 'sandbox', payload: { type: 'reply', lead_id: base.payload.lead_id } }))
        .statusCode,
    ).toBe(400);
  });

  it('returns 501 for the smartlead provider until that adapter exists', async () => {
    expect((await post({ provider: 'smartlead', payload: {} })).statusCode).toBe(501);
  });
});
