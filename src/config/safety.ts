// path: src/config/safety.ts

import { z } from 'zod';
import { isValidTimeZone } from '../utils/zoned-time.js';

/* ============================================================================
 * Per-channel safety settings (stored in channels.settings, jsonb)
 *
 * The defaults are the cautious ones. A customer can make a number MORE careful. They cannot
 * lift the warm-up caps below: those protect the number, and therefore our reputation.
 * ========================================================================== */

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:mm');

const shape = {
  /** IANA name, for example "Africa/Dar_es_Salaam". Daily counters and working hours follow it. */
  timezone: z.string().refine(isValidTimeZone, 'Unknown time zone').default('UTC'),
  /** Automations only send inside this window, like a person who sleeps. */
  workingHours: z.object({ start: hhmm.default('07:00'), end: hhmm.default('21:00') }).default({ start: '07:00', end: '21:00' }),
  /** Write to people who never wrote first. Off by default: the biggest single cause of bans. */
  allowColdOutreach: z.boolean().default(true),
  /** Reading pauses, typing indicator and pauses between messages. */
  humanize: z.boolean().default(true),
  /** Lowers the daily cap further. Cannot raise it. */
  dailyLimit: z.number().int().min(1).max(2000).optional(),
};

/** Reading stored settings: unknown extra keys are ignored, missing ones get the safe default. */
export const safetySettingsSchema = z.object(shape);
export type SafetySettings = z.infer<typeof safetySettingsSchema>;

/** Updating settings: only these keys, any subset. */
export const safetySettingsPatchSchema = z.object(shape).partial().strict();
export type SafetySettingsPatch = z.infer<typeof safetySettingsPatchSchema>;

export function loadSafetySettings(raw: unknown): SafetySettings {
  const parsed = safetySettingsSchema.safeParse(raw);
  return parsed.success ? parsed.data : safetySettingsSchema.parse({});
}

/* ============================================================================
 * Warm-up: a new number that suddenly sends hundreds of messages is the classic ban pattern.
 * Illustrative values, tune them with your own ban data.
 * ========================================================================== */

const WARMUP_STEPS: ReadonlyArray<{ untilDay: number; dailyCap: number }> = [
  { untilDay: 3, dailyCap: 20 },
  { untilDay: 7, dailyCap: 50 },
  { untilDay: 14, dailyCap: 120 },
  { untilDay: 30, dailyCap: 250 },
  { untilDay: Number.POSITIVE_INFINITY, dailyCap: 500 },
];

export interface SendingCaps {
  perDay: number;
  perHour: number;
  groupMessagesPerDay: number;
  /** People this number has never exchanged a message with. */
  newRecipientsPerDay: number;
  perDirectRecipientPerHour: number;
  perGroupPerHour: number;
  /** The same text sent to this many different chats within an hour is held back. */
  identicalPerHour: number;
  statusViewsPerDay: number;
}

export function computeCaps(input: { accountAgeDays: number; planDailyLimit: number; settings: SafetySettings }): SendingCaps {
  const warmup = WARMUP_STEPS.find((step) => input.accountAgeDays < step.untilDay)?.dailyCap ?? 500;
  const perDay = Math.max(1, Math.min(warmup, input.planDailyLimit, input.settings.dailyLimit ?? Number.POSITIVE_INFINITY));

  return {
    perDay,
    perHour: Math.max(5, Math.ceil(perDay / 5)),
    groupMessagesPerDay: Math.max(5, Math.floor(perDay * 0.4)),
    newRecipientsPerDay: Math.max(3, Math.floor(perDay * 0.25)),
    perDirectRecipientPerHour: 3,
    perGroupPerHour: 4,
    identicalPerHour: 4,
    statusViewsPerDay: 60,
  };
}