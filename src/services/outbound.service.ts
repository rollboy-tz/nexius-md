// path: src/services/outbound.service.ts

import { and, desc, eq, inArray, like, lt, gt } from 'drizzle-orm';
import { db } from '../config/database.js';
import { StatusCodes } from '../constants/status-codes.js';
import {
  channelMessages,
  channelOptOuts,
  type DeliveryStatus,
  type MessageKind,
} from '../db/schema.js';
import { enqueueMessageJob, removeJob } from '../queue/outbound.queue.js';
import type {
  MessageMedia,
  OutboundContent,
  OutboundPayload,
  ParsedMessage,
  StatusAudience,
} from '../types/message.types.js';
import { ApiError } from '../utils/api.error.js';
import { isUniqueViolation } from '../utils/db-errors.js';
import { isGroupJid, resolveRecipient, STATUS_JID } from '../utils/jid.util.js';
import { assertSafeImageUrl } from '../utils/safe-fetch.js';
import { contentFingerprint, MAX_CAPTION_LENGTH, prepareText } from '../utils/whatsapp-format.js';
import { OutboundPolicy, type Origin, type SendIntent } from './outbound-policy.service.js';

/* ============================================================================
 * Types
 * ========================================================================== */

export interface EnqueueInput {
  organizationId: string;
  channelId: string;
  origin: Origin;
  content: OutboundContent;
  /** Required for TEXT and IMAGE. Ignored for statuses. */
  to?: string | undefined;
  scheduledFor?: Date | undefined;
  /** The same key on the same channel never creates a second message. */
  idempotencyKey?: string | undefined;
  automationId?: string | undefined;
  priority?: 'INTERACTIVE' | 'BULK' | undefined;
  statusAudience?: StatusAudience | undefined;
  statusStyle?: { backgroundColor?: string | undefined; font?: number | undefined } | undefined;
}

export interface QueuedMessage {
  id: string;
  kind: MessageKind;
  to: string;
  deliveryStatus: DeliveryStatus;
  scheduledFor: Date | null;
  /** True when the idempotency key matched an earlier request and nothing new was created. */
  duplicate: boolean;
}

export interface MessageListQuery {
  deliveryStatus?: DeliveryStatus | undefined;
  direction?: 'INBOUND' | 'OUTBOUND' | undefined;
  before?: Date | undefined;
  limit?: number | undefined;
}

const MESSAGE_VIEW = {
  id: channelMessages.id,
  direction: channelMessages.direction,
  kind: channelMessages.kind,
  deliveryStatus: channelMessages.deliveryStatus,
  fromAddress: channelMessages.fromAddress,
  toAddress: channelMessages.toAddress,
  content: channelMessages.content,
  entities: channelMessages.entities,
  links: channelMessages.links,
  mentions: channelMessages.mentions,
  media: channelMessages.media,
  scheduledFor: channelMessages.scheduledFor,
  sentAt: channelMessages.sentAt,
  attempts: channelMessages.attempts,
  failureReason: channelMessages.failureReason,
  createdAt: channelMessages.createdAt,
} as const;

const MAX_SCHEDULE_AHEAD_MS = 30 * 24 * 3600 * 1000;

export const DEFAULT_STATUS_AUDIENCE: StatusAudience = { mode: 'RECENT_CONTACTS', days: 60, max: 300 };

/* ============================================================================
 * Service
 * ========================================================================== */

export class OutboundService {
  /**
   * Accepts a message for sending. Nothing is sent here: the message is validated, checked against
   * the number's safety rules, stored as QUEUED, and handed to the queue. The worker sends it later,
   * at a human pace. Everything that can be refused is refused NOW, so the caller finds out
   * immediately instead of minutes later.
   */
  public static async enqueue(input: EnqueueInput): Promise<QueuedMessage> {
    const { content } = input;
    const isStatus = content.kind === 'STATUS_TEXT' || content.kind === 'STATUS_IMAGE';
    const recipient = isStatus ? STATUS_JID : resolveRecipient(input.to ?? '');

    let text: ParsedMessage | null = null;
    let media: MessageMedia | null = null;

    if (content.kind === 'TEXT' || content.kind === 'STATUS_TEXT') {
      text = prepareText(content.text);
    } else {
      assertSafeImageUrl(content.imageUrl); // shape only; the download is re-checked when it happens
      text = content.caption ? prepareText(content.caption, MAX_CAPTION_LENGTH) : null;
      media = {
        type: 'image',
        mimetype: null,
        sizeBytes: null,
        width: null,
        height: null,
        sha256: null,
        caption: text?.text ?? null,
        sourceUrl: content.imageUrl,
        storageKey: null,
      };
    }

    const scheduledFor = input.scheduledFor;
    if (scheduledFor && scheduledFor.getTime() - Date.now() > MAX_SCHEDULE_AHEAD_MS) {
      throw ApiError.badRequest('A message can be scheduled at most 30 days ahead.', 'SCHEDULE_TOO_FAR');
    }

    const ctx = await OutboundPolicy.loadContext(input.channelId);
    if (!ctx || ctx.organizationId !== input.organizationId) {
      throw ApiError.notFound('Channel not found.', 'CHANNEL_NOT_FOUND');
    }

    const intent: SendIntent = {
      recipient,
      isGroup: isGroupJid(recipient),
      isStatus,
      origin: input.origin,
      fingerprint: contentFingerprint(text?.text ?? media?.sourceUrl ?? ''),
    };

    const refusal = await OutboundPolicy.refusal(ctx, intent);
    if (refusal) throw ApiError.forbidden(refusal.message, refusal.code);

    const payload: OutboundPayload = {
      ...(isStatus ? { audience: input.statusAudience ?? DEFAULT_STATUS_AUDIENCE } : {}),
      ...(input.statusStyle?.backgroundColor ? { backgroundColor: input.statusStyle.backgroundColor } : {}),
      ...(input.statusStyle?.font !== undefined ? { font: input.statusStyle.font } : {}),
    };

    let row: { id: string; deliveryStatus: DeliveryStatus; scheduledFor: Date | null } | undefined;

    try {
      [row] = await db
        .insert(channelMessages)
        .values({
          organizationId: input.organizationId,
          channelId: input.channelId,
          direction: 'OUTBOUND',
          kind: content.kind,
          deliveryStatus: 'QUEUED',
          fromAddress: ctx.ownAddress,
          toAddress: recipient,
          content: text?.text ?? null,
          entities: text?.entities ?? [],
          links: text?.links ?? [],
          mentions: text?.mentions ?? [],
          media,
          payload: Object.keys(payload).length > 0 ? payload : null,
          idempotencyKey: input.idempotencyKey ?? null,
          automationId: input.automationId ?? null,
          scheduledFor: scheduledFor ?? null,
        })
        .returning({
          id: channelMessages.id,
          deliveryStatus: channelMessages.deliveryStatus,
          scheduledFor: channelMessages.scheduledFor,
        });
    } catch (error) {
      if (input.idempotencyKey && isUniqueViolation(error, 'channel_messages_idempotency_uq')) {
        const [existing] = await db
          .select({ id: channelMessages.id, deliveryStatus: channelMessages.deliveryStatus, scheduledFor: channelMessages.scheduledFor })
          .from(channelMessages)
          .where(and(eq(channelMessages.channelId, input.channelId), eq(channelMessages.idempotencyKey, input.idempotencyKey)))
          .limit(1);

        if (existing) return { ...existing, kind: content.kind, to: recipient, duplicate: true };
      }
      throw error;
    }

    if (!row) throw ApiError.internal('Could not store the message.', 'MESSAGE_STORE_FAILED');

    try {
      await enqueueMessageJob(row.id, {
        delayMs: scheduledFor ? scheduledFor.getTime() - Date.now() : 0,
        priority: input.priority ?? (input.origin === 'API' ? 'INTERACTIVE' : 'BULK'),
      });
    } catch (error) {
      console.error('❌ [Outbound] Could not enqueue message:', error);
      await db
        .update(channelMessages)
        .set({ deliveryStatus: 'FAILED', failureReason: 'QUEUE_UNAVAILABLE' })
        .where(eq(channelMessages.id, row.id));

      throw new ApiError(StatusCodes.CONFLICT, 'The sending queue is unavailable. Try again shortly.', 'QUEUE_UNAVAILABLE');
    }

    return { id: row.id, kind: content.kind, to: recipient, deliveryStatus: row.deliveryStatus, scheduledFor: row.scheduledFor, duplicate: false };
  }

  /* ------------------------------ follow-up ------------------------------ */

  public static async get(organizationId: string, channelId: string, messageId: string) {
    const [message] = await db
      .select(MESSAGE_VIEW)
      .from(channelMessages)
      .where(
        and(
          eq(channelMessages.id, messageId),
          eq(channelMessages.channelId, channelId),
          eq(channelMessages.organizationId, organizationId),
        ),
      )
      .limit(1);

    if (!message) throw ApiError.notFound('Message not found.', 'MESSAGE_NOT_FOUND');
    return message;
  }

  /** Newest first. Page backwards with `before` = the createdAt of the last item you received. */
  public static async list(organizationId: string, channelId: string, query: MessageListQuery) {
    const limit = Math.min(100, Math.max(1, query.limit ?? 30));

    const rows = await db
      .select(MESSAGE_VIEW)
      .from(channelMessages)
      .where(
        and(
          eq(channelMessages.channelId, channelId),
          eq(channelMessages.organizationId, organizationId),
          query.deliveryStatus ? eq(channelMessages.deliveryStatus, query.deliveryStatus) : undefined,
          query.direction ? eq(channelMessages.direction, query.direction) : undefined,
          query.before ? lt(channelMessages.createdAt, query.before) : undefined,
        ),
      )
      .orderBy(desc(channelMessages.createdAt))
      .limit(limit);

    return { data: rows, nextBefore: rows.length === limit ? (rows[rows.length - 1]?.createdAt ?? null) : null };
  }

  /** Only a message that has not started sending can be cancelled. The row decides, not the queue. */
  public static async cancel(organizationId: string, channelId: string, messageId: string): Promise<void> {
    const [cancelled] = await db
      .update(channelMessages)
      .set({ deliveryStatus: 'CANCELLED', failureReason: 'CANCELLED_BY_USER' })
      .where(
        and(
          eq(channelMessages.id, messageId),
          eq(channelMessages.channelId, channelId),
          eq(channelMessages.organizationId, organizationId),
          eq(channelMessages.direction, 'OUTBOUND'),
          eq(channelMessages.deliveryStatus, 'QUEUED'),
        ),
      )
      .returning({ id: channelMessages.id });

    if (!cancelled) {
      await this.get(organizationId, channelId, messageId); // 404 if it does not exist
      throw new ApiError(StatusCodes.CONFLICT, 'This message can no longer be cancelled.', 'NOT_CANCELLABLE');
    }

    await removeJob(messageId);
  }

  /* ---------------------------- status audience ---------------------------- */

  /**
   * WhatsApp shows a status only to the people we list. We can only vouch for people this number has
   * really talked to, so the default audience is "people who wrote to us recently", minus anyone who opted out.
   */
  public static async resolveStatusAudience(channelId: string, audience: StatusAudience = DEFAULT_STATUS_AUDIENCE): Promise<string[]> {
    const max = Math.min(500, Math.max(1, audience.max ?? 300));

    let candidates: string[];
    if (audience.mode === 'LIST') {
      candidates = [...new Set(audience.jids ?? [])].filter((jid) => jid.endsWith('@s.whatsapp.net')).slice(0, max);
    } else {
      const since = new Date(Date.now() - (audience.days ?? 60) * 86_400_000);
      const rows = await db
        .selectDistinct({ address: channelMessages.fromAddress })
        .from(channelMessages)
        .where(
          and(
            eq(channelMessages.channelId, channelId),
            eq(channelMessages.direction, 'INBOUND'),
            like(channelMessages.fromAddress, '%@s.whatsapp.net'),
            gt(channelMessages.createdAt, since),
          ),
        )
        .limit(max);
      candidates = rows.map((row) => row.address);
    }

    if (candidates.length === 0) return [];

    const optedOut = await db
      .select({ address: channelOptOuts.address })
      .from(channelOptOuts)
      .where(and(eq(channelOptOuts.channelId, channelId), inArray(channelOptOuts.address, candidates)));

    const excluded = new Set(optedOut.map((row) => row.address));
    return candidates.filter((jid) => !excluded.has(jid));
  }
}