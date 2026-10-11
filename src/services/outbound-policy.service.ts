// path: src/services/outbound-policy.service.ts

import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../config/database.js';
import { resolveLimits } from '../config/plans.js';
import { redis } from '../config/redis.js';
import { computeCaps, loadSafetySettings, type SafetySettings, type SendingCaps } from '../config/safety.js';
import { channelMessages, channelOptOuts, channels, organizations } from '../db/schema.js';
import { localDateKey, localHourKey, localParts, minutesOfDay, msUntilLocalTime } from '../utils/zoned-time.js';
import { HumanizerService } from './humanizer.service.js';

/* ============================================================================
 * Types
 * ========================================================================== */

export type Origin = 'API' | 'AUTOMATION';

/** Everything the policy needs to know about the number sending. */
export interface ChannelContext {
  channelId: string;
  organizationId: string;
  organizationActive: boolean;
  ownAddress: string;
  settings: SafetySettings;
  accountAgeDays: number;
  caps: SendingCaps;
}

/** One thing we are about to send. */
export interface SendIntent {
  recipient: string;
  isGroup: boolean;
  isStatus: boolean;
  origin: Origin;
  fingerprint: string;
}

export type PolicyDecision =
  | { action: 'SEND'; verifyRecipient: boolean; isNewRecipient: boolean }
  | { action: 'DELAY'; delayMs: number; reason: string }
  | { action: 'REJECT'; code: string; message: string };

export type FailureKind = 'RATE_LIMITED' | 'LOGGED_OUT' | 'PERMANENT' | 'TRANSIENT';

/* ============================================================================
 * Redis helpers. Every counter lives under wa:safe:<channelId>: and expires by itself.
 *
 * Counters are read and written by ONE worker at a time per channel (the worker holds a
 * per-channel lock), so read-then-increment cannot race.
 * ========================================================================== */

const INCREMENT_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return count
`;

const k = (channelId: string, ...parts: string[]): string => `wa:safe:${channelId}:${parts.join(':')}`;

const incr = async (key: string, ttlSeconds: number): Promise<number> =>
  Number(await redis.eval(INCREMENT_SCRIPT, 1, key, ttlSeconds));

const read = async (key: string): Promise<number> => Number((await redis.get(key)) ?? 0);

const DAY_TTL = 2 * 24 * 3600;
const HOUR_TTL = 2 * 3600;
const MINUTE = 60_000;

const msUntilNextHour = (now: Date, timeZone: string): number => {
  const { minute, second } = localParts(now, timeZone);
  return 3_600_000 - (minute * 60 + second) * 1000;
};

/* ============================================================================
 * Service
 * ========================================================================== */

export class OutboundPolicy {
  /* ------------------------------ context ------------------------------ */

  /** Null when the channel is gone (deleted, or its organization is). */
  public static async loadContext(channelId: string): Promise<ChannelContext | null> {
    const [row] = await db
      .select({
        organizationId: channels.organizationId,
        externalId: channels.externalId,
        settings: channels.settings,
        firstConnectedAt: channels.firstConnectedAt,
        planType: organizations.planType,
        limitOverrides: organizations.limitOverrides,
        organizationStatus: organizations.status,
      })
      .from(channels)
      .innerJoin(organizations, eq(organizations.id, channels.organizationId))
      .where(and(eq(channels.id, channelId), isNull(channels.deletedAt), isNull(organizations.deletedAt)))
      .limit(1);

    if (!row) return null;

    const settings = loadSafetySettings(row.settings);
    const accountAgeDays = row.firstConnectedAt
      ? Math.floor((Date.now() - row.firstConnectedAt.getTime()) / 86_400_000)
      : 0;
    const planDailyLimit = resolveLimits(row.planType, row.limitOverrides).messagesPerDay;

    return {
      channelId,
      organizationId: row.organizationId,
      organizationActive: row.organizationStatus === 'ACTIVE',
      ownAddress: row.externalId ?? 'self',
      settings,
      accountAgeDays,
      caps: computeCaps({ accountAgeDays, planDailyLimit, settings }),
    };
  }

  /* ------------------------------ lookups ------------------------------ */

  /** "Warm" = this person has written to us at least once. Replying to them is what a normal account does. */
  public static async isWarmContact(channelId: string, address: string): Promise<boolean> {
    const [row] = await db
      .select({ id: channelMessages.id })
      .from(channelMessages)
      .where(
        and(
          eq(channelMessages.channelId, channelId),
          eq(channelMessages.direction, 'INBOUND'),
          eq(channelMessages.fromAddress, address),
        ),
      )
      .limit(1);

    return Boolean(row);
  }

  public static async isOptedOut(channelId: string, address: string): Promise<boolean> {
    const [row] = await db
      .select({ id: channelOptOuts.id })
      .from(channelOptOuts)
      .where(and(eq(channelOptOuts.channelId, channelId), eq(channelOptOuts.address, address)))
      .limit(1);

    return Boolean(row);
  }

  /* ------------------------------- pausing ------------------------------- */

  /** Stops all sending from a number for a while (circuit breaker). */
  public static async pause(channelId: string, ms: number, reason: string): Promise<void> {
    await redis.set(k(channelId, 'paused'), reason, 'PX', ms);
  }

  public static async resume(channelId: string): Promise<void> {
    await redis.del(k(channelId, 'paused'));
  }

  /* ------------------------------ decisions ------------------------------ */

  /**
   * Refusals that will never become acceptable by waiting. Checked when a message is accepted,
   * so the caller learns immediately instead of finding a failed message minutes later.
   */
  public static async refusal(ctx: ChannelContext, intent: SendIntent): Promise<Extract<PolicyDecision, { action: 'REJECT' }> | null> {
    if (!ctx.organizationActive) {
      return { action: 'REJECT', code: 'ORGANIZATION_SUSPENDED', message: 'This organization is suspended.' };
    }
    if (intent.isGroup || intent.isStatus) return null;

    if (await this.isOptedOut(ctx.channelId, intent.recipient)) {
      return { action: 'REJECT', code: 'RECIPIENT_OPTED_OUT', message: 'This person asked not to receive messages.' };
    }

    if (!ctx.settings.allowColdOutreach && !(await this.isWarmContact(ctx.channelId, intent.recipient))) {
      return {
        action: 'REJECT',
        code: 'COLD_OUTREACH_BLOCKED',
        message: 'This person has not written to this number first. Cold outreach is off to protect the number.',
      };
    }

    return null;
  }

  /** Decides, right now, whether this message may leave. Called by the worker for every attempt. */
  public static async evaluate(ctx: ChannelContext, intent: SendIntent): Promise<PolicyDecision> {
    const refused = await this.refusal(ctx, intent);
    if (refused) return refused;

    const now = new Date();
    const { timezone, workingHours } = ctx.settings;
    const { caps } = ctx;

    const pausedFor = await redis.pttl(k(ctx.channelId, 'paused'));
    if (pausedFor > 0) return { action: 'DELAY', delayMs: Math.min(pausedFor, 10 * MINUTE), reason: 'CHANNEL_PAUSED' };

    // Automations behave like a person with a day: nothing in the middle of the night.
    if (intent.origin === 'AUTOMATION') {
      const { hour, minute } = localParts(now, timezone);
      const current = hour * 60 + minute;
      const start = minutesOfDay(workingHours.start);
      const end = minutesOfDay(workingHours.end);
      const inside = start <= end ? current >= start && current < end : current >= start || current < end;

      if (!inside) {
        return {
          action: 'DELAY',
          delayMs: msUntilLocalTime(now, timezone, workingHours.start) + HumanizerService.between(0, 20 * MINUTE),
          reason: 'OUTSIDE_WORKING_HOURS',
        };
      }
    }

    const gap = await redis.pttl(k(ctx.channelId, 'gap'));
    if (gap > 0) return { action: 'DELAY', delayMs: gap + HumanizerService.between(200, 1500), reason: 'PACING' };

    const dayKey = localDateKey(now, timezone);
    const hourKey = localHourKey(now, timezone);
    const untilTomorrow = (): number => msUntilLocalTime(now, timezone, '00:00') + HumanizerService.between(5 * MINUTE, 60 * MINUTE);
    const untilNextHour = (): number => msUntilNextHour(now, timezone) + HumanizerService.between(MINUTE, 10 * MINUTE);

    const [daily, hourly] = await Promise.all([read(k(ctx.channelId, 'd', dayKey)), read(k(ctx.channelId, 'h', hourKey))]);
    if (daily >= caps.perDay) return { action: 'DELAY', delayMs: untilTomorrow(), reason: 'DAILY_LIMIT' };
    if (hourly >= caps.perHour) return { action: 'DELAY', delayMs: untilNextHour(), reason: 'HOURLY_LIMIT' };

    if (intent.isStatus) return { action: 'SEND', verifyRecipient: false, isNewRecipient: false };

    if (intent.isGroup) {
      if ((await read(k(ctx.channelId, 'g', dayKey))) >= caps.groupMessagesPerDay) {
        return { action: 'DELAY', delayMs: untilTomorrow(), reason: 'GROUP_DAILY_LIMIT' };
      }
    }

    const perRecipient = await read(k(ctx.channelId, 'r', intent.recipient, hourKey));
    const recipientLimit = intent.isGroup ? caps.perGroupPerHour : caps.perDirectRecipientPerHour;
    if (perRecipient >= recipientLimit) return { action: 'DELAY', delayMs: untilNextHour(), reason: 'RECIPIENT_LIMIT' };

    // The same words going to many chats is the clearest "bot" signal. Beyond a few, wait for the next hour.
    const identicalKey = k(ctx.channelId, 'x', intent.fingerprint, hourKey);
    const [identicalCount, alreadySent] = await Promise.all([
      redis.scard(identicalKey),
      redis.sismember(identicalKey, intent.recipient),
    ]);
    if (alreadySent === 0 && identicalCount >= caps.identicalPerHour) {
      return { action: 'DELAY', delayMs: untilNextHour(), reason: 'IDENTICAL_CONTENT' };
    }

    let isNewRecipient = false;
    if (!intent.isGroup && !(await this.isWarmContact(ctx.channelId, intent.recipient))) {
      isNewRecipient = true; // refusal() already let it through, so cold outreach is on for this number
      if ((await read(k(ctx.channelId, 'n', dayKey))) >= caps.newRecipientsPerDay) {
        return { action: 'DELAY', delayMs: untilTomorrow(), reason: 'NEW_RECIPIENT_LIMIT' };
      }
    }

    // A number that was never confirmed to be on WhatsApp must be checked before the first message.
    return { action: 'SEND', verifyRecipient: isNewRecipient, isNewRecipient };
  }

  /** Called after a successful send: updates every counter and decides how long to wait before the next one. */
  public static async recordSent(ctx: ChannelContext, intent: SendIntent, decision: { isNewRecipient: boolean }): Promise<void> {
    const now = new Date();
    const { timezone } = ctx.settings;
    const dayKey = localDateKey(now, timezone);
    const hourKey = localHourKey(now, timezone);

    const writes: Array<Promise<unknown>> = [
      incr(k(ctx.channelId, 'd', dayKey), DAY_TTL),
      incr(k(ctx.channelId, 'h', hourKey), HOUR_TTL),
    ];

    if (!intent.isStatus) {
      writes.push(incr(k(ctx.channelId, 'r', intent.recipient, hourKey), HOUR_TTL));

      const identicalKey = k(ctx.channelId, 'x', intent.fingerprint, hourKey);
      writes.push(redis.sadd(identicalKey, intent.recipient).then(() => redis.expire(identicalKey, HOUR_TTL)));

      if (intent.isGroup) writes.push(incr(k(ctx.channelId, 'g', dayKey), DAY_TTL));
      if (decision.isNewRecipient) writes.push(incr(k(ctx.channelId, 'n', dayKey), DAY_TTL));
    }

    await Promise.all(writes);

    // Every so often, a real pause. The interval itself is random, so there is no rhythm to learn.
    const streak = await incr(k(ctx.channelId, 'streak'), 6 * 3600);
    const takeBreak = streak % HumanizerService.between(10, 18) === 0;
    const wait = takeBreak ? HumanizerService.breakDuration() : HumanizerService.gapBetweenMessages(intent.isGroup);

    await redis.set(k(ctx.channelId, 'gap'), '1', 'PX', wait);
  }

  /** Status views are cheap, but a person does not view hundreds a day. */
  public static async allowStatusView(ctx: ChannelContext, maxPerDay: number): Promise<boolean> {
    const dayKey = localDateKey(new Date(), ctx.settings.timezone);
    const views = await incr(k(ctx.channelId, 'sv', dayKey), DAY_TTL);
    return views <= Math.min(maxPerDay, ctx.caps.statusViewsPerDay);
  }

  /* ---------------------------- circuit breaker ---------------------------- */

  public static classifyError(error: unknown): FailureKind {
    const candidate = error as { output?: { statusCode?: number }; statusCode?: number; message?: unknown } | null;
    const status = candidate?.output?.statusCode ?? candidate?.statusCode;
    const message = typeof candidate?.message === 'string' ? candidate.message.toLowerCase() : '';

    if (status === 429 || message.includes('rate-overlimit')) return 'RATE_LIMITED';
    if (status === 401 || message.includes('logged out') || message.includes('not-authorized')) return 'LOGGED_OUT';
    if (status === 400 || status === 404 || message.includes('item-not-found') || message.includes('invalid jid')) return 'PERMANENT';
    return 'TRANSIENT';
  }

  /**
   * WhatsApp pushing back is the strongest warning there is. On an explicit rate limit we stop
   * the number for two hours; repeated failures stop it for half an hour. Better a slow day than a banned number.
   */
  public static async recordFailure(channelId: string, kind: FailureKind): Promise<void> {
    if (kind === 'RATE_LIMITED') {
      await this.pause(channelId, 2 * 3600_000, 'WHATSAPP_RATE_LIMIT');
      return;
    }
    if (kind === 'LOGGED_OUT') {
      await this.pause(channelId, 24 * 3600_000, 'LOGGED_OUT');
      return;
    }
    if (kind === 'TRANSIENT') {
      const failures = await incr(k(channelId, 'fail'), 600);
      if (failures >= 3) await this.pause(channelId, 30 * MINUTE, 'REPEATED_FAILURES');
    }
  }
}