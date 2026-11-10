import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { planSendTimes } from '../lib/schedule.js';
import type { ResolvedDeps } from '../server.js';

const Body = z.object({
  timezone: z.string().min(1).optional(),
  country: z.string().length(2).optional(),
  delays: z.array(z.number().int().min(0).max(60)).min(1).max(5),
  now: z.string().datetime().optional(),
});

/** A lead's zone when the lead has none: the capital's zone for the countries a campaign is likely to target. */
const COUNTRY_TZ: Record<string, string> = {
  US: 'America/New_York', CA: 'America/Toronto', GB: 'Europe/London', IE: 'Europe/Dublin', DE: 'Europe/Berlin',
  FR: 'Europe/Paris', NL: 'Europe/Amsterdam', ES: 'Europe/Madrid', IT: 'Europe/Rome', SE: 'Europe/Stockholm',
  PK: 'Asia/Karachi', IN: 'Asia/Kolkata', AE: 'Asia/Dubai', AU: 'Australia/Sydney',
};

export function registerSchedule(app: FastifyInstance, deps: ResolvedDeps): void {
  app.post('/v1/schedule/plan', async (req, reply) => {
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const { delays, country, now } = parsed.data;
    const timezone = parsed.data.timezone ?? COUNTRY_TZ[(country ?? '').toUpperCase()] ?? 'UTC';
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: timezone }); // throws RangeError for an unknown zone
      const times = planSendTimes({
        now: now ? new Date(now) : new Date(),
        tz: timezone,
        windows: deps.sending.windows,
        jitterMinutes: deps.sending.jitter_minutes,
        delays,
        rng: deps.rng,
        mode: deps.config.mode,
        sandboxStepDelayMinutes: deps.config.sandboxStepDelayMinutes,
      });
      return {
        mode: deps.config.mode,
        live_send_enabled: deps.config.liveSendEnabled,
        timezone,
        times: times.map((t, i) => ({ step: i + 1, at: t.toISOString() })),
      };
    } catch (err) {
      return reply.code(400).send({ error: 'invalid_timezone', message: (err as Error).message });
    }
  });
}
