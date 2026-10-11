// path: src/services/automation.service.ts

import { createHash, randomUUID } from 'node:crypto';
import { and, asc, count, desc, eq, inArray, isNotNull, isNull, lte, sql } from 'drizzle-orm';
import { db } from '../config/database.js';
import { redis } from '../config/redis.js';
import { StatusCodes } from '../constants/status-codes.js';
import { automations, channels, messageTemplates, type Automation, type AutomationType, type MessageTemplate } from '../db/schema.js';
import type { Tx } from '../db/types.js';
import {
  broadcastConfigSchema,
  statusPostConfigSchema,
  statusViewConfigSchema,
  type CreateAutomationBody,
  type CreateTemplateBody,
  type ListAutomationsQuery,
  type Schedule,
  type StatusViewConfig,
  type UpdateAutomationBody,
  type UpdateTemplateBody,
} from '../schemas/automation.schema.js';
import { ApiError } from '../utils/api.error.js';
import { isUniqueViolation } from '../utils/db-errors.js';
import { resolveRecipient } from '../utils/jid.util.js';
import { assertSafeImageUrl } from '../utils/safe-fetch.js';
import { prepareText } from '../utils/whatsapp-format.js';
import { localParts, minutesOfDay, zonedTimeToUtc } from '../utils/zoned-time.js';
import { AuditService, type RequestMeta } from './audit.service.js';
import { HumanizerService } from './humanizer.service.js';
import { OutboundService } from './outbound.service.js';

const MAX_TEMPLATES_PER_ORG = 200;
const MAX_AUTOMATIONS_PER_CHANNEL = 20;
const TICK_MS = 30_000;
const LEADER_KEY = 'wa:scheduler:leader';

const conflict = (message: string, code: string): ApiError => new ApiError(StatusCodes.CONFLICT, message, code);
const statusViewCacheKey = (channelId: string): string => `wa:sv:${channelId}`;

/* ============================================================================
 * When does an automation run next?
 *
 * Never on the dot. Daily times drift by a random number of minutes, intervals by a percentage,
 * so a customer's number does not start talking at exactly 09:00:00 every single day.
 * ========================================================================== */

export function computeNextRun(schedule: Schedule, from: Date): Date | null {
  switch (schedule.kind) {
    case 'ONCE':
      return schedule.at.getTime() > from.getTime() ? schedule.at : null;

    case 'INTERVAL': {
      const base = schedule.everyMinutes * 60_000;
      const next = HumanizerService.jitter(base, schedule.jitterPercent / 100);
      return new Date(from.getTime() + Math.max(next, 30 * 60_000));
    }

    case 'DAILY': {
      const { year, month, day } = localParts(from, schedule.timezone);
      const candidates: number[] = [];

      for (let dayOffset = 0; dayOffset <= 2; dayOffset += 1) {
        const date = new Date(Date.UTC(year, month - 1, day + dayOffset));

        for (const time of schedule.times) {
          const minutes = minutesOfDay(time);
          const base = zonedTimeToUtc(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), Math.floor(minutes / 60), minutes % 60, schedule.timezone);
          const drift = HumanizerService.between(-schedule.jitterMinutes, schedule.jitterMinutes) * 60_000;
          candidates.push(base.getTime() + drift);
        }
      }

      const next = candidates.filter((time) => time > from.getTime() + 60_000).sort((a, b) => a - b)[0];
      return next === undefined ? null : new Date(next);
    }
  }
}

const shuffle = <T>(items: readonly T[]): T[] => {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = HumanizerService.between(0, i);
    [copy[i], copy[j]] = [copy[j] as T, copy[i] as T];
  }
  return copy;
};

const shortHash = (value: string): string => createHash('sha1').update(value).digest('hex').slice(0, 10);

/* ============================================================================
 * Service
 * ========================================================================== */

export class AutomationService {
  /* ------------------------------ saved messages ------------------------------ */

  public static async listTemplates(organizationId: string): Promise<MessageTemplate[]> {
    return db
      .select()
      .from(messageTemplates)
      .where(and(eq(messageTemplates.organizationId, organizationId), isNull(messageTemplates.deletedAt)))
      .orderBy(desc(messageTemplates.createdAt));
  }

  public static async getTemplate(organizationId: string, templateId: string): Promise<MessageTemplate> {
    const [template] = await db
      .select()
      .from(messageTemplates)
      .where(and(eq(messageTemplates.id, templateId), eq(messageTemplates.organizationId, organizationId), isNull(messageTemplates.deletedAt)))
      .limit(1);

    if (!template) throw ApiError.notFound('Saved message not found.', 'TEMPLATE_NOT_FOUND');
    return template;
  }

  public static async createTemplate(organizationId: string, actorUserId: string, dto: CreateTemplateBody, meta: RequestMeta): Promise<MessageTemplate> {
    const [used] = await db
      .select({ value: count() })
      .from(messageTemplates)
      .where(and(eq(messageTemplates.organizationId, organizationId), isNull(messageTemplates.deletedAt)));
    if ((used?.value ?? 0) >= MAX_TEMPLATES_PER_ORG) {
      throw conflict('You have reached the limit of saved messages.', 'TEMPLATE_LIMIT_REACHED');
    }

    const body = prepareText(dto.body);
    const variants = dto.variants.map((variant) => prepareText(variant).text);
    if (dto.mediaUrl) assertSafeImageUrl(dto.mediaUrl);

    try {
      return await db.transaction(async (tx) => {
        const [created] = await tx
          .insert(messageTemplates)
          .values({
            organizationId,
            name: dto.name,
            body: body.text,
            variants,
            mediaUrl: dto.mediaUrl ?? null,
            entities: body.entities,
            createdByUserId: actorUserId,
          })
          .returning();

        if (!created) throw ApiError.internal('Could not save the message.', 'TEMPLATE_CREATE_FAILED');

        await AuditService.record(
          { organizationId, actorUserId, action: 'template.created', targetType: 'template', targetId: created.id, meta },
          tx,
        );
        return created;
      });
    } catch (error) {
      if (isUniqueViolation(error, 'message_templates_org_name_uq')) {
        throw conflict('A saved message with this name already exists.', 'TEMPLATE_NAME_TAKEN');
      }
      throw error;
    }
  }

  public static async updateTemplate(
    organizationId: string,
    actorUserId: string,
    templateId: string,
    dto: UpdateTemplateBody,
    meta: RequestMeta,
  ): Promise<MessageTemplate> {
    await this.getTemplate(organizationId, templateId);

    const patch: Partial<typeof messageTemplates.$inferInsert> = {};
    if (dto.name !== undefined) patch.name = dto.name;
    if (dto.body !== undefined) {
      const body = prepareText(dto.body);
      patch.body = body.text;
      patch.entities = body.entities;
    }
    if (dto.variants !== undefined) patch.variants = dto.variants.map((variant) => prepareText(variant).text);
    if (dto.mediaUrl !== undefined) {
      if (dto.mediaUrl) assertSafeImageUrl(dto.mediaUrl);
      patch.mediaUrl = dto.mediaUrl;
    }

    try {
      return await db.transaction(async (tx) => {
        const [updated] = await tx
          .update(messageTemplates)
          .set(patch)
          .where(and(eq(messageTemplates.id, templateId), eq(messageTemplates.organizationId, organizationId), isNull(messageTemplates.deletedAt)))
          .returning();

        if (!updated) throw ApiError.notFound('Saved message not found.', 'TEMPLATE_NOT_FOUND');

        await AuditService.record(
          { organizationId, actorUserId, action: 'template.updated', targetType: 'template', targetId: templateId, meta },
          tx,
        );
        return updated;
      });
    } catch (error) {
      if (isUniqueViolation(error, 'message_templates_org_name_uq')) {
        throw conflict('A saved message with this name already exists.', 'TEMPLATE_NAME_TAKEN');
      }
      throw error;
    }
  }

  public static async removeTemplate(organizationId: string, actorUserId: string, templateId: string, meta: RequestMeta): Promise<void> {
    const [inUse] = await db
      .select({ id: automations.id })
      .from(automations)
      .where(
        and(
          eq(automations.organizationId, organizationId),
          isNull(automations.deletedAt),
          sql`${automations.config}->>'templateId' = ${templateId}`,
        ),
      )
      .limit(1);

    if (inUse) throw conflict('This message is used by an automation. Remove or change the automation first.', 'TEMPLATE_IN_USE');

    await db.transaction(async (tx) => {
      const [removed] = await tx
        .update(messageTemplates)
        .set({ deletedAt: new Date() })
        .where(and(eq(messageTemplates.id, templateId), eq(messageTemplates.organizationId, organizationId), isNull(messageTemplates.deletedAt)))
        .returning({ id: messageTemplates.id });

      if (!removed) throw ApiError.notFound('Saved message not found.', 'TEMPLATE_NOT_FOUND');

      await AuditService.record(
        { organizationId, actorUserId, action: 'template.deleted', targetType: 'template', targetId: templateId, meta },
        tx,
      );
    });
  }

  /* ------------------------------- automations ------------------------------- */

  private static async assertChannel(organizationId: string, channelId: string): Promise<void> {
    const [channel] = await db
      .select({ id: channels.id })
      .from(channels)
      .where(
        and(eq(channels.id, channelId), eq(channels.organizationId, organizationId), eq(channels.provider, 'WHATSAPP'), isNull(channels.deletedAt)),
      )
      .limit(1);

    if (!channel) throw ApiError.notFound('Channel not found.', 'CHANNEL_NOT_FOUND');
  }

  private static async assertTemplate(organizationId: string, templateId: string): Promise<void> {
    await this.getTemplate(organizationId, templateId);
  }

  /** A schedule must produce a first run. A one-time run in the past is an error, not a silent no-op. */
  private static firstRun(schedule: Schedule): Date {
    const next = computeNextRun(schedule, new Date());
    if (!next || next.getTime() < Date.now() + 60_000) {
      throw ApiError.badRequest('The schedule has no upcoming run. Choose a time in the future.', 'SCHEDULE_IN_PAST');
    }
    return next;
  }

  /** Validates `config` against the automation's own type and normalises it (for example, target ids). */
  private static validateConfig(type: AutomationType, raw: unknown): Record<string, unknown> {
    const fail = (message: string): never => {
      throw ApiError.badRequest(message, 'INVALID_AUTOMATION_CONFIG');
    };

    switch (type) {
      case 'BROADCAST': {
        const parsed = broadcastConfigSchema.safeParse(raw);
        if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? 'Invalid configuration.');
        return { ...parsed.data, targets: [...new Set(parsed.data.targets.map(resolveRecipient))] };
      }
      case 'STATUS_POST': {
        const parsed = statusPostConfigSchema.safeParse(raw);
        return parsed.success ? parsed.data : fail(parsed.error.issues[0]?.message ?? 'Invalid configuration.');
      }
      case 'STATUS_VIEW': {
        const parsed = statusViewConfigSchema.safeParse(raw);
        return parsed.success ? parsed.data : fail(parsed.error.issues[0]?.message ?? 'Invalid configuration.');
      }
      default:
        return fail('This automation type is not available yet.');
    }
  }

  private static scheduleOf(type: AutomationType, config: Record<string, unknown>): Schedule | null {
    if (type === 'BROADCAST') return broadcastConfigSchema.parse(config).schedule;
    if (type === 'STATUS_POST') return statusPostConfigSchema.parse(config).schedule;
    return null;
  }

  public static async listAutomations(organizationId: string, query: ListAutomationsQuery): Promise<Automation[]> {
    return db
      .select()
      .from(automations)
      .where(
        and(
          eq(automations.organizationId, organizationId),
          isNull(automations.deletedAt),
          query.channelId ? eq(automations.channelId, query.channelId) : undefined,
          query.type ? eq(automations.type, query.type) : undefined,
        ),
      )
      .orderBy(desc(automations.createdAt));
  }

  public static async getAutomation(organizationId: string, automationId: string): Promise<Automation> {
    const [row] = await db
      .select()
      .from(automations)
      .where(and(eq(automations.id, automationId), eq(automations.organizationId, organizationId), isNull(automations.deletedAt)))
      .limit(1);

    if (!row) throw ApiError.notFound('Automation not found.', 'AUTOMATION_NOT_FOUND');
    return row;
  }

  public static async createAutomation(
    organizationId: string,
    actorUserId: string,
    input: CreateAutomationBody,
    meta: RequestMeta,
  ): Promise<Automation> {
    await this.assertChannel(organizationId, input.channelId);

    const [existing] = await db
      .select({ value: count() })
      .from(automations)
      .where(and(eq(automations.channelId, input.channelId), isNull(automations.deletedAt)));
    if ((existing?.value ?? 0) >= MAX_AUTOMATIONS_PER_CHANNEL) {
      throw conflict('This channel has reached its automation limit.', 'AUTOMATION_LIMIT_REACHED');
    }

    if (input.type === 'BROADCAST' || input.type === 'STATUS_POST') {
      await this.assertTemplate(organizationId, input.config.templateId);
    }

    const config = this.validateConfig(input.type, input.config);
    const schedule = this.scheduleOf(input.type, config);
    const nextRunAt = input.enabled && schedule ? this.firstRun(schedule) : null;

    try {
      const row = await db.transaction(async (tx) => {
        const [created] = await tx
          .insert(automations)
          .values({
            organizationId,
            channelId: input.channelId,
            name: input.name,
            type: input.type,
            enabled: input.enabled,
            config,
            nextRunAt,
            createdByUserId: actorUserId,
          })
          .returning();

        if (!created) throw ApiError.internal('Could not create the automation.', 'AUTOMATION_CREATE_FAILED');

        await AuditService.record(
          {
            organizationId,
            actorUserId,
            action: 'automation.created',
            targetType: 'automation',
            targetId: created.id,
            metadata: { type: input.type, channelId: input.channelId },
            meta,
          },
          tx,
        );
        return created;
      });

      if (input.type === 'STATUS_VIEW') await redis.del(statusViewCacheKey(input.channelId));
      return row;
    } catch (error) {
      if (isUniqueViolation(error, 'automations_status_view_uq')) {
        throw conflict('This channel already has a status-viewing policy. Edit it instead.', 'STATUS_VIEW_EXISTS');
      }
      throw error;
    }
  }

  public static async updateAutomation(
    organizationId: string,
    actorUserId: string,
    automationId: string,
    dto: UpdateAutomationBody,
    meta: RequestMeta,
  ): Promise<Automation> {
    const current = await this.getAutomation(organizationId, automationId);

    const config = dto.config !== undefined ? this.validateConfig(current.type, dto.config) : current.config;
    if (dto.config !== undefined && (current.type === 'BROADCAST' || current.type === 'STATUS_POST')) {
      await this.assertTemplate(organizationId, String((config as { templateId?: unknown }).templateId));
    }

    const enabled = dto.enabled ?? current.enabled;
    const schedule = this.scheduleOf(current.type, config);
    const reschedule = dto.config !== undefined || (dto.enabled === true && !current.enabled);

    const row = await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(automations)
        .set({
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          enabled,
          config,
          ...(reschedule ? { nextRunAt: enabled && schedule ? this.firstRun(schedule) : null, lastError: null } : {}),
          ...(!enabled ? { nextRunAt: null } : {}),
        })
        .where(and(eq(automations.id, automationId), eq(automations.organizationId, organizationId), isNull(automations.deletedAt)))
        .returning();

      if (!updated) throw ApiError.notFound('Automation not found.', 'AUTOMATION_NOT_FOUND');

      await AuditService.record(
        { organizationId, actorUserId, action: 'automation.updated', targetType: 'automation', targetId: automationId, meta },
        tx,
      );
      return updated;
    });

    if (current.type === 'STATUS_VIEW') await redis.del(statusViewCacheKey(current.channelId));
    return row;
  }

  public static async removeAutomation(organizationId: string, actorUserId: string, automationId: string, meta: RequestMeta): Promise<void> {
    const current = await this.getAutomation(organizationId, automationId);

    await db.transaction(async (tx) => {
      await tx
        .update(automations)
        .set({ deletedAt: new Date(), enabled: false, nextRunAt: null })
        .where(and(eq(automations.id, automationId), eq(automations.organizationId, organizationId)));

      await AuditService.record(
        { organizationId, actorUserId, action: 'automation.deleted', targetType: 'automation', targetId: automationId, meta },
        tx,
      );
    });

    if (current.type === 'STATUS_VIEW') await redis.del(statusViewCacheKey(current.channelId));
  }

  /* --------------------------- status-viewing policy --------------------------- */

  /** Null when the customer has no such policy (or turned it off). Cached for a minute: it is asked on every status. */
  public static async getStatusViewPolicy(channelId: string): Promise<StatusViewConfig | null> {
    const cached = await redis.get(statusViewCacheKey(channelId));
    if (cached !== null) {
      if (cached === 'none') return null;
      const parsed = statusViewConfigSchema.safeParse(JSON.parse(cached));
      return parsed.success ? parsed.data : null;
    }

    const [row] = await db
      .select({ config: automations.config })
      .from(automations)
      .where(
        and(eq(automations.channelId, channelId), eq(automations.type, 'STATUS_VIEW'), eq(automations.enabled, true), isNull(automations.deletedAt)),
      )
      .limit(1);

    const parsed = row ? statusViewConfigSchema.safeParse(row.config) : null;
    const policy = parsed?.success ? parsed.data : null;

    await redis.set(statusViewCacheKey(channelId), policy ? JSON.stringify(policy) : 'none', 'EX', 60);
    return policy;
  }

  /* ---------------------------------- scheduler ---------------------------------- */

  private static timer: NodeJS.Timeout | null = null;
  private static readonly instanceId = randomUUID();

  /** One scheduler loop per process; a Redis key makes sure only one process acts per tick. */
  public static startScheduler(): void {
    if (this.timer) return;

    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref();
    void this.tick();
    console.log('⏱️ [Automation] Scheduler started.');
  }

  public static stopScheduler(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private static async tick(): Promise<void> {
    try {
      const leader = await redis.set(LEADER_KEY, this.instanceId, 'PX', TICK_MS - 2_000, 'NX');
      if (leader !== 'OK') return;

      const now = new Date();

      await db.transaction(async (tx) => {
        // SKIP LOCKED: even if two processes ever overlap, a row is handled by exactly one of them.
        const due = await tx
          .select()
          .from(automations)
          .where(
            and(
              eq(automations.enabled, true),
              isNull(automations.deletedAt),
              inArray(automations.type, ['BROADCAST', 'STATUS_POST']),
              isNotNull(automations.nextRunAt),
              lte(automations.nextRunAt, now),
            ),
          )
          .orderBy(asc(automations.nextRunAt))
          .limit(25)
          .for('update', { skipLocked: true });

        for (const row of due) await this.runOne(tx, row, now);
      });
    } catch (error) {
      console.error('❌ [Automation] Scheduler tick failed:', error);
    }
  }

  private static async runOne(tx: Tx, row: Automation, now: Date): Promise<void> {
    try {
      const [channel] = await tx.select({ status: channels.status }).from(channels).where(eq(channels.id, row.channelId)).limit(1);

      // A disconnected number does not post. Look again soon; nothing is lost.
      if (!channel || channel.status !== 'CONNECTED') {
        await tx
          .update(automations)
          .set({ nextRunAt: new Date(now.getTime() + 10 * 60_000), lastError: 'CHANNEL_NOT_CONNECTED' })
          .where(eq(automations.id, row.id));
        return;
      }

      const outcome = row.type === 'BROADCAST' ? await this.runBroadcast(row, now) : await this.runStatusPost(row, now);
      const schedule = this.scheduleOf(row.type, row.config);
      const next = schedule ? computeNextRun(schedule, now) : null;

      await tx
        .update(automations)
        .set({
          lastRunAt: now,
          runCount: sql`${automations.runCount} + 1`,
          nextRunAt: next,
          enabled: next !== null,
          lastError: outcome,
        })
        .where(eq(automations.id, row.id));
    } catch (error) {
      console.error(`❌ [Automation] ${row.id} failed:`, error instanceof Error ? error.message : error);
      await tx
        .update(automations)
        .set({ nextRunAt: new Date(now.getTime() + 15 * 60_000), lastError: (error instanceof Error ? error.message : 'UNKNOWN').slice(0, 200) })
        .where(eq(automations.id, row.id));
    }
  }

  /** One of the template's wordings, chosen at random, so a broadcast is not the same sentence repeated. */
  private static pickWording(template: MessageTemplate): string {
    const wordings = [template.body, ...template.variants];
    return wordings[HumanizerService.between(0, wordings.length - 1)] ?? template.body;
  }

  /** Sends to every target, one after another with random gaps, in random order. Returns a note for `lastError`, or null. */
  private static async runBroadcast(row: Automation, now: Date): Promise<string | null> {
    const config = broadcastConfigSchema.parse(row.config);
    const template = await this.getTemplate(row.organizationId, config.templateId);

    const runStamp = row.nextRunAt?.getTime() ?? now.getTime();
    let offsetMs = 0;
    const problems = new Map<string, number>();

    for (const target of shuffle(config.targets)) {
      offsetMs += HumanizerService.between(config.staggerSeconds.min, config.staggerSeconds.max) * 1000;
      const wording = this.pickWording(template);

      try {
        await OutboundService.enqueue({
          organizationId: row.organizationId,
          channelId: row.channelId,
          origin: 'AUTOMATION',
          automationId: row.id,
          to: target,
          content: template.mediaUrl ? { kind: 'IMAGE', imageUrl: template.mediaUrl, caption: wording } : { kind: 'TEXT', text: wording },
          scheduledFor: new Date(now.getTime() + offsetMs),
          idempotencyKey: `auto-${row.id}-${runStamp}-${shortHash(target)}`, // a repeated tick cannot double-send
          priority: 'BULK',
        });
      } catch (error) {
        const code = (error as { code?: unknown }).code;
        const key = typeof code === 'string' ? code : 'ERROR';
        problems.set(key, (problems.get(key) ?? 0) + 1);
      }
    }

    const skipped = [...problems.values()].reduce((sum, value) => sum + value, 0);
    if (skipped === config.targets.length) throw new Error([...problems.keys()][0] ?? 'NOTHING_ENQUEUED');

    return skipped > 0 ? `${skipped} skipped: ${[...problems.keys()].join(', ')}` : null;
  }

  private static async runStatusPost(row: Automation, now: Date): Promise<string | null> {
    const config = statusPostConfigSchema.parse(row.config);
    const template = await this.getTemplate(row.organizationId, config.templateId);
    const wording = this.pickWording(template);

    await OutboundService.enqueue({
      organizationId: row.organizationId,
      channelId: row.channelId,
      origin: 'AUTOMATION',
      automationId: row.id,
      content: template.mediaUrl ? { kind: 'STATUS_IMAGE', imageUrl: template.mediaUrl, caption: wording } : { kind: 'STATUS_TEXT', text: wording },
      // Posted some minutes after the schedule says, never at the exact same second.
      scheduledFor: new Date(now.getTime() + HumanizerService.between(0, 10 * 60_000)),
      idempotencyKey: `auto-${row.id}-${row.nextRunAt?.getTime() ?? now.getTime()}-status`,
      statusAudience: config.audience,
      statusStyle: { backgroundColor: config.backgroundColor, font: config.font },
      priority: 'BULK',
    });

    return null;
  }
}