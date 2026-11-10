import { describe, expect, it } from 'vitest';
import { addBusinessDays, nextSendTime, planSendTimes, type SendWindows } from '../src/lib/schedule.js';
import { buildServer } from '../src/server.js';
import { authHeaders, testConfig } from './helpers.js';

const WINDOWS: SendWindows = { days: ['Tue', 'Wed', 'Thu'], local_start: '09:00', local_end: '11:30' };
const NY = 'America/New_York';

function local(d: Date, tz: string): { day: string; hm: string; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return { day: get('weekday'), hm: `${get('hour')}:${get('minute')}`, minutes: Number(get('hour')) * 60 + Number(get('minute')) };
}

describe('nextSendTime', () => {
  it('on a Friday returns the following Tuesday at the window start when rng is 0', () => {
    const t = nextSendTime(new Date('2026-11-13T15:00:00Z'), NY, WINDOWS, 40, () => 0);
    expect(t.toISOString()).toBe('2026-11-17T14:00:00.000Z');
    expect(local(t, NY)).toMatchObject({ day: 'Tue', hm: '09:00' });
  });
  it('adds jitter inside the window', () => {
    const t = nextSendTime(new Date('2026-11-13T15:00:00Z'), NY, WINDOWS, 40, () => 0.5);
    expect(local(t, NY)).toMatchObject({ day: 'Tue', hm: '09:20' });
  });
  it('never lands outside 09:00 to 11:30 local for any rng value', () => {
    for (const r of [0, 0.25, 0.5, 0.75, 0.999999]) {
      const m = local(nextSendTime(new Date('2026-11-13T15:00:00Z'), NY, WINDOWS, 40, () => r), NY).minutes;
      expect(m).toBeGreaterThanOrEqual(9 * 60);
      expect(m).toBeLessThanOrEqual(11 * 60 + 30);
    }
  });
  it('clamps jitter at the window end when starting late in the window', () => {
    // Tue 11:20 local, 40 minutes of jitter would pass 11:30
    const t = nextSendTime(new Date('2026-11-17T16:20:00Z'), NY, WINDOWS, 40, () => 0.999999);
    expect(local(t, NY)).toMatchObject({ day: 'Tue', hm: '11:30' });
  });
  it('sends within the same window when now is inside it and jitter is 0', () => {
    const now = new Date('2026-11-17T15:30:00Z'); // 10:30 local
    expect(nextSendTime(now, NY, WINDOWS, 0, () => 0).toISOString()).toBe(now.toISOString());
  });
  it('rolls to the next allowed day after the window has closed', () => {
    const t = nextSendTime(new Date('2026-11-17T17:00:00Z'), NY, WINDOWS, 40, () => 0); // Tue 12:00 local
    expect(local(t, NY)).toMatchObject({ day: 'Wed', hm: '09:00' });
  });
  it('skips Monday and the weekend', () => {
    const t = nextSendTime(new Date('2026-11-15T12:00:00Z'), NY, WINDOWS, 0, () => 0); // Sunday
    expect(local(t, NY)).toMatchObject({ day: 'Tue', hm: '09:00' });
  });
  it('handles the spring DST change (EDT is UTC-4)', () => {
    const t = nextSendTime(new Date('2026-03-06T20:00:00Z'), NY, WINDOWS, 0, () => 0);
    expect(t.toISOString()).toBe('2026-03-10T13:00:00.000Z');
  });
  it('handles the autumn DST change (EST is UTC-5)', () => {
    const t = nextSendTime(new Date('2026-10-30T20:00:00Z'), NY, WINDOWS, 0, () => 0);
    expect(t.toISOString()).toBe('2026-11-03T14:00:00.000Z');
  });
  it('works for a zone ahead of UTC', () => {
    const t = nextSendTime(new Date('2026-11-13T15:00:00Z'), 'Asia/Karachi', WINDOWS, 0, () => 0);
    expect(local(t, 'Asia/Karachi')).toMatchObject({ day: 'Tue', hm: '09:00' });
  });
  it('rejects an unknown time zone', () => {
    expect(() => nextSendTime(new Date(), 'Mars/Base', WINDOWS, 0, () => 0)).toThrow();
  });
});

describe('addBusinessDays', () => {
  const d = (s: string) => new Date(`${s}T10:00:00Z`);
  it.each([
    ['2026-11-13', 1, '2026-11-16'], // Fri + 1 = Mon
    ['2026-11-13', 3, '2026-11-18'], // Fri + 3 = Wed
    ['2026-11-14', 1, '2026-11-16'], // Sat + 1 = Mon
    ['2026-11-15', 1, '2026-11-16'], // Sun + 1 = Mon
    ['2026-11-16', 5, '2026-11-23'],
    ['2026-11-17', 7, '2026-11-26'],
    ['2026-11-13', 0, '2026-11-13'],
  ])('%s + %i business days = %s', (from, n, to) => {
    expect(addBusinessDays(d(from), n).toISOString().slice(0, 10)).toBe(to);
  });
  it('keeps the time of day', () => {
    expect(addBusinessDays(d('2026-11-13'), 1).toISOString()).toBe('2026-11-16T10:00:00.000Z');
  });
  it('rejects a negative count', () => {
    expect(() => addBusinessDays(d('2026-11-13'), -1)).toThrow();
  });
});

describe('planSendTimes', () => {
  const base = { now: new Date('2026-11-13T15:00:00Z'), tz: NY, windows: WINDOWS, jitterMinutes: 40, delays: [0, 3, 7], rng: () => 0 };
  it('live: every step inside a window, strictly increasing, delays honoured', () => {
    const t = planSendTimes({ ...base, mode: 'live', sandboxStepDelayMinutes: 3 });
    expect(t).toHaveLength(3);
    expect(t[0]!.toISOString()).toBe('2026-11-17T14:00:00.000Z');
    expect(t[1]! > t[0]! && t[2]! > t[1]!).toBe(true);
    for (const x of t) expect(['Tue', 'Wed', 'Thu']).toContain(local(x, NY).day);
    expect(t[1]!.getTime() - t[0]!.getTime()).toBeGreaterThanOrEqual(3 * 24 * 3600 * 1000 - 1);
  });
  it('sandbox: compresses delays to SANDBOX_STEP_DELAY_MINUTES per step', () => {
    const t = planSendTimes({ ...base, mode: 'sandbox', sandboxStepDelayMinutes: 3 });
    expect(t.map((x) => x.toISOString())).toEqual(['2026-11-13T15:00:00.000Z', '2026-11-13T15:03:00.000Z', '2026-11-13T15:06:00.000Z']);
  });
});

describe('POST /v1/schedule/plan', () => {
  const call = (cfg: Parameters<typeof testConfig>[0], payload: object) =>
    buildServer({ config: testConfig(cfg), rng: () => 0 }).inject({ method: 'POST', url: '/v1/schedule/plan', headers: authHeaders, payload });

  it('sandbox returns compressed times and the mode', async () => {
    const res = await call({ mode: 'sandbox', sandboxStepDelayMinutes: 2 }, { timezone: NY, delays: [0, 3, 7], now: '2026-11-13T15:00:00Z' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      mode: 'sandbox',
      live_send_enabled: false,
      timezone: NY,
      times: [
        { step: 1, at: '2026-11-13T15:00:00.000Z' },
        { step: 2, at: '2026-11-13T15:02:00.000Z' },
        { step: 3, at: '2026-11-13T15:04:00.000Z' },
      ],
    });
  });
  it('live uses the configured windows', async () => {
    const res = await call({ mode: 'live', liveSendEnabled: true }, { timezone: NY, delays: [0], now: '2026-11-13T15:00:00Z' });
    expect(res.json()).toMatchObject({ mode: 'live', live_send_enabled: true, times: [{ step: 1, at: '2026-11-17T14:00:00.000Z' }] });
  });
  it('derives the zone from the country when none is given, and falls back to UTC', async () => {
    const gb = await call({ mode: 'live' }, { country: 'GB', delays: [0], now: '2026-11-13T15:00:00Z' });
    expect(gb.json().timezone).toBe('Europe/London');
    const none = await call({ mode: 'live' }, { delays: [0], now: '2026-11-13T15:00:00Z' });
    expect(none.json().timezone).toBe('UTC');
  });
  it('rejects an unknown time zone and empty delays', async () => {
    expect((await call({}, { timezone: 'Mars/Base', delays: [0] })).statusCode).toBe(400);
    expect((await call({}, { delays: [] })).statusCode).toBe(400);
  });
});
