import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';

export interface SendWindows {
  days: string[];
  local_start: string;
  local_end: string;
}
export interface SendingRules {
  windows: SendWindows;
  jitter_minutes: number;
  sequence_delays_business_days: number[];
}

export function loadSendingRules(configDir: string): SendingRules {
  const doc = parse(readFileSync(path.join(configDir, 'defaults.yaml'), 'utf8')) as { sending: SendingRules };
  return doc.sending;
}

const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MIN = 60_000;

interface Local {
  y: number;
  m: number;
  d: number;
  minutes: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23',
    });
    formatters.set(tz, f);
  }
  return f;
}

function localParts(date: Date, tz: string): Local & { seconds: number } {
  const p = Object.fromEntries(fmt(tz).formatToParts(date).map((x) => [x.type, Number(x.value)]));
  return { y: p.year!, m: p.month!, d: p.day!, minutes: p.hour! * 60 + p.minute!, seconds: p.second! };
}

/** Offset of `tz` from UTC at an instant, in ms. */
function offsetAt(instant: number, tz: string): number {
  const l = localParts(new Date(instant), tz);
  const asUtc = Date.UTC(l.y, l.m - 1, l.d, Math.floor(l.minutes / 60), l.minutes % 60, l.seconds);
  return asUtc - Math.floor(instant / 1000) * 1000;
}

/** UTC instant of a wall-clock time in `tz` (settles on the offset in force at that local time, DST aware). */
function zonedToUtc(y: number, m: number, d: number, minutes: number, tz: string): number {
  const guess = Date.UTC(y, m - 1, d, Math.floor(minutes / 60), minutes % 60);
  const first = guess - offsetAt(guess, tz);
  return guess - offsetAt(first, tz);
}

function parseHm(s: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!m) throw new Error(`bad time "${s}"`);
  return Number(m[1]) * 60 + Number(m[2]);
}

/**
 * The next moment to send: the first allowed day and window at or after `now` in the lead's zone, plus up to
 * `jitterMinutes` of random delay that is clamped so it never passes the window end.
 */
export function nextSendTime(now: Date, tz: string, windows: SendWindows, jitterMinutes: number, rng: () => number): Date {
  fmt(tz); // throws RangeError for an unknown zone
  const start = parseHm(windows.local_start);
  const end = parseHm(windows.local_end);
  if (!(end > start)) throw new Error('window end must be after start');
  const allowed = new Set(windows.days);
  if (allowed.size === 0) throw new Error('windows.days is empty');

  const today = localParts(now, tz);
  for (let offset = 0; offset < 15; offset++) {
    // Calendar arithmetic on the local date, independent of DST.
    const cal = new Date(Date.UTC(today.y, today.m - 1, today.d + offset));
    if (!allowed.has(DAY[cal.getUTCDay()]!)) continue;
    const y = cal.getUTCFullYear();
    const m = cal.getUTCMonth() + 1;
    const d = cal.getUTCDate();
    const windowStart = zonedToUtc(y, m, d, start, tz);
    const windowEnd = zonedToUtc(y, m, d, end, tz);
    if (now.getTime() >= windowEnd) continue;
    const earliest = Math.max(now.getTime(), windowStart);
    const jittered = earliest + Math.floor(rng() * jitterMinutes * MIN);
    return new Date(Math.min(jittered, windowEnd));
  }
  throw new Error('no send window found in the next 15 days');
}

/** Adds weekdays, skipping Saturday and Sunday (UTC calendar), keeping the time of day. */
export function addBusinessDays(d: Date, n: number): Date {
  if (!Number.isInteger(n) || n < 0) throw new Error('n must be a non-negative integer');
  const out = new Date(d.getTime());
  let left = n;
  while (left > 0) {
    out.setUTCDate(out.getUTCDate() + 1);
    const dow = out.getUTCDay();
    if (dow !== 0 && dow !== 6) left--;
  }
  return out;
}

export interface PlanOptions {
  now: Date;
  tz: string;
  windows: SendWindows;
  jitterMinutes: number;
  /** Business days between a step and the one before it; the first entry is normally 0. */
  delays: number[];
  rng: () => number;
  mode: 'sandbox' | 'live';
  sandboxStepDelayMinutes: number;
}

/** Send time per step. Live: each step waits its business-day delay, then takes the next window. Sandbox: minutes. */
export function planSendTimes(o: PlanOptions): Date[] {
  const out: Date[] = [];
  o.delays.forEach((delay, i) => {
    if (o.mode === 'sandbox') {
      out.push(new Date(o.now.getTime() + i * o.sandboxStepDelayMinutes * MIN * (delay > 0 || i > 0 ? 1 : 0)));
      return;
    }
    const base = i === 0 ? o.now : addBusinessDays(out[i - 1]!, delay);
    out.push(nextSendTime(base, o.tz, o.windows, o.jitterMinutes, o.rng));
  });
  return out;
}
