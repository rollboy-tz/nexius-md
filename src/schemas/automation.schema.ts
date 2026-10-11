// path: src/schemas/automation.schema.ts

import { z } from 'zod';
import { isValidTimeZone } from '../utils/zoned-time.js';

const uuid = z.string().uuid('Invalid id');
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:mm');
const orgParams = z.object({ organizationId: uuid });

/* ============================================================================
 * Schedules. The minimum repeat is 30 minutes: a schedule that fires every minute is not a person.
 * Every run is also randomised, so "every day at 09:00" really means "around 09:00, a different minute each day".
 * ========================================================================== */

export const scheduleSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ONCE'), at: z.coerce.date() }).strict(),
  z
    .object({
      kind: z.literal('INTERVAL'),
      everyMinutes: z.number().int().min(30).max(10_080),
      jitterPercent: z.number().min(0).max(50).default(20),
    })
    .strict(),
  z
    .object({
      kind: z.literal('DAILY'),
      times: z.array(hhmm).min(1).max(6),
      jitterMinutes: z.number().int().min(0).max(120).default(15),
      timezone: z.string().refine(isValidTimeZone, 'Unknown time zone'),
    })
    .strict(),
]);
export type Schedule = z.infer<typeof scheduleSchema>;

export const statusAudienceSchema = z
  .object({
    mode: z.enum(['RECENT_CONTACTS', 'LIST']),
    days: z.number().int().min(1).max(365).optional(),
    max: z.number().int().min(1).max(500).optional(),
    jids: z.array(z.string().trim().max(128)).max(500).optional(),
  })
  .strict()
  .refine((value) => value.mode !== 'LIST' || (value.jids?.length ?? 0) > 0, { message: 'LIST needs at least one jid', path: ['jids'] });

/* ============================================================================
 * Per-type config
 * ========================================================================== */

/** Send a saved message to groups or people, spread out over time. */
export const broadcastConfigSchema = z
  .object({
    templateId: uuid,
    /** Phone numbers or group ids. */
    targets: z.array(z.string().trim().min(1).max(128)).min(1).max(100),
    schedule: scheduleSchema,
    /** Gap between one target and the next, in seconds, drawn at random for each one. */
    staggerSeconds: z
      .object({ min: z.number().int().min(15).max(600).default(25), max: z.number().int().min(20).max(1800).default(90) })
      .refine((value) => value.max >= value.min, { message: 'max must be at least min' })
      .default({ min: 25, max: 90 }),
  })
  .strict();

/** Post a saved message as a WhatsApp status. */
export const statusPostConfigSchema = z
  .object({
    templateId: uuid,
    schedule: scheduleSchema,
    audience: statusAudienceSchema.default({ mode: 'RECENT_CONTACTS', days: 60, max: 300 }),
    backgroundColor: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use #RRGGBB').optional(),
    font: z.number().int().min(0).max(10).optional(),
  })
  .strict();

/**
 * Look at other people's statuses like a person would: not every one, and never right away.
 * Each update gets a random decision (view or skip) and a random delay.
 */
export const statusViewConfigSchema = z
  .object({
    viewProbability: z.number().min(0).max(1).default(0.6),
    minDelayMinutes: z.number().int().min(2).max(720).default(5),
    maxDelayMinutes: z.number().int().min(5).max(1440).default(240),
    maxPerDay: z.number().int().min(1).max(200).default(40),
  })
  .strict()
  .refine((value) => value.maxDelayMinutes >= value.minDelayMinutes, { message: 'maxDelayMinutes must be at least minDelayMinutes' });

export type BroadcastConfig = z.infer<typeof broadcastConfigSchema>;
export type StatusPostConfig = z.infer<typeof statusPostConfigSchema>;
export type StatusViewConfig = z.infer<typeof statusViewConfigSchema>;

/* ============================================================================
 * Request schemas
 * ========================================================================== */

const templateName = z.string().trim().min(2).max(100);
const templateBody = z.string().min(1).max(4096);
const templateVariants = z.array(templateBody).max(10);
const templateMedia = z.string().trim().url().max(2048);

const templateParams = z.object({ organizationId: uuid, templateId: uuid });
const automationParams = z.object({ organizationId: uuid, automationId: uuid });

const automationBase = { name: z.string().trim().min(2).max(100), channelId: uuid, enabled: z.boolean().default(true) };

export const automationSchema = {
  /* ------------------------------ templates ------------------------------ */
  listTemplates: { params: orgParams },

  createTemplate: {
    params: orgParams,
    body: z
      .object({ name: templateName, body: templateBody, variants: templateVariants.default([]), mediaUrl: templateMedia.nullable().optional() })
      .strict(),
  },

  getTemplate: { params: templateParams },

  updateTemplate: {
    params: templateParams,
    body: z
      .object({ name: templateName.optional(), body: templateBody.optional(), variants: templateVariants.optional(), mediaUrl: templateMedia.nullable().optional() })
      .strict()
      .refine((value) => Object.values(value).some((field) => field !== undefined), { message: 'Provide at least one field to update' }),
  },

  removeTemplate: { params: templateParams },

  /* ----------------------------- automations ----------------------------- */
  listAutomations: {
    params: orgParams,
    query: z.object({
      channelId: uuid.optional(),
      type: z.enum(['BROADCAST', 'STATUS_POST', 'STATUS_VIEW']).optional(),
    }),
  },

  createAutomation: {
    params: orgParams,
    body: z.discriminatedUnion('type', [
      z.object({ ...automationBase, type: z.literal('BROADCAST'), config: broadcastConfigSchema }).strict(),
      z.object({ ...automationBase, type: z.literal('STATUS_POST'), config: statusPostConfigSchema }).strict(),
      z.object({ ...automationBase, type: z.literal('STATUS_VIEW'), config: statusViewConfigSchema }).strict(),
    ]),
  },

  getAutomation: { params: automationParams },

  /** `config` is checked against the automation's own type in the service. */
  updateAutomation: {
    params: automationParams,
    body: z
      .object({
        name: z.string().trim().min(2).max(100).optional(),
        enabled: z.boolean().optional(),
        config: z.record(z.string(), z.unknown()).optional(),
      })
      .strict()
      .refine((value) => Object.values(value).some((field) => field !== undefined), { message: 'Provide at least one field to update' }),
  },

  removeAutomation: { params: automationParams },
};

export type CreateTemplateBody = z.infer<typeof automationSchema.createTemplate.body>;
export type UpdateTemplateBody = z.infer<typeof automationSchema.updateTemplate.body>;
export type TemplateParams = z.infer<typeof automationSchema.getTemplate.params>;
export type CreateAutomationBody = z.infer<typeof automationSchema.createAutomation.body>;
export type UpdateAutomationBody = z.infer<typeof automationSchema.updateAutomation.body>;
export type AutomationParams = z.infer<typeof automationSchema.getAutomation.params>;
export type ListAutomationsQuery = z.infer<typeof automationSchema.listAutomations.query>;