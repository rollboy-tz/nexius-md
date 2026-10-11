// path: src/queue/outbound.worker.ts

import { randomUUID } from 'node:crypto';
import { DelayedError, UnrecoverableError, Worker, type Job } from 'bullmq';
import type { WASocket } from '@whiskeysockets/baileys';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../config/database.js';
import { redis } from '../config/redis.js';
import { channelMessages, type ChannelMessage } from '../db/schema.js';
import { AutomationService } from '../services/automation.service.js';
import { HumanizerService } from '../services/humanizer.service.js';
import { MessageService } from '../services/message.service.js';
import { OutboundPolicy, type ChannelContext, type SendIntent } from '../services/outbound-policy.service.js';
import { OutboundService } from '../services/outbound.service.js';
import { waSessionManager } from '../services/wa-session.manager.js';
import { ApiError } from '../utils/api.error.js';
import { isGroupJid, STATUS_JID } from '../utils/jid.util.js';
import { fetchImageSafely } from '../utils/safe-fetch.js';
import { contentFingerprint } from '../utils/whatsapp-format.js';
import { createQueueConnection, OUTBOUND_QUEUE, type OutboundJobData } from './outbound.queue.js';

/* ============================================================================
 * What the worker guarantees
 *
 *  - ONE send at a time per number (a Redis lock). Different numbers run in parallel; one number
 *    never has two messages "being typed" at once, which no human does.
 *  - Every attempt asks the policy first: caps, pacing, working hours, opt-out, cold outreach.
 *  - At most once: a message found in SENDING after a crash is marked uncertain, never re-sent.
 *    A missed message can be re-sent by a person; a duplicate cannot be taken back.
 *  - A job that has to wait is MOVED to a later time. It does not occupy a worker slot.
 * ========================================================================== */

const LOCK_TTL_MS = 120_000;
const MAX_MESSAGE_AGE_MS = 48 * 3600 * 1000;
const MAX_HOUSEKEEPING_AGE_MS = 2 * 3600 * 1000;

const lockKey = (channelId: string): string => `wa:lock:${channelId}`;

const RELEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end
`;

async function acquireLock(channelId: string): Promise<string | null> {
  const token = randomUUID();
  const result = await redis.set(lockKey(channelId), token, 'PX', LOCK_TTL_MS, 'NX');
  return result === 'OK' ? token : null;
}

async function releaseLock(channelId: string, token: string): Promise<void> {
  await redis.eval(RELEASE_SCRIPT, 1, lockKey(channelId), token);
}

/** Moves the job to a later time and leaves the worker slot free. */
async function delayJob(job: Job<OutboundJobData>, token: string | undefined, ms: number): Promise<never> {
  await job.moveToDelayed(Date.now() + Math.max(1000, ms), token);
  throw new DelayedError();
}

const errorCode = (error: unknown): string | undefined => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
};

const reasonOf = (error: unknown): string =>
  (errorCode(error) ?? (error instanceof Error ? error.message : 'UNKNOWN_ERROR')).slice(0, 200);

async function markFailed(messageId: string, reason: string): Promise<void> {
  await db
    .update(channelMessages)
    .set({ deliveryStatus: 'FAILED', failureReason: reason.slice(0, 200) })
    .where(and(eq(channelMessages.id, messageId), inArray(channelMessages.deliveryStatus, ['QUEUED', 'SENDING'])));
}

/* ============================================================================
 * MESSAGE
 * ========================================================================== */

async function processMessage(job: Job<OutboundJobData>, token: string | undefined, messageId: string): Promise<void> {
  const [row] = await db.select().from(channelMessages).where(eq(channelMessages.id, messageId)).limit(1);
  if (!row) return;

  if (row.deliveryStatus === 'SENDING') {
    // The process died after claiming this message. We cannot know whether it left, so it is never sent again.
    await markFailed(row.id, 'DELIVERY_UNCERTAIN');
    return;
  }
  if (row.deliveryStatus !== 'QUEUED') return; // cancelled, already sent, already failed

  if (Date.now() - row.createdAt.getTime() > MAX_MESSAGE_AGE_MS) {
    await markFailed(row.id, 'EXPIRED');
    return;
  }

  if (row.scheduledFor && row.scheduledFor.getTime() > Date.now() + 1000) {
    return delayJob(job, token, row.scheduledFor.getTime() - Date.now());
  }

  const ctx = await OutboundPolicy.loadContext(row.channelId);
  if (!ctx) {
    await markFailed(row.id, 'CHANNEL_UNAVAILABLE');
    return;
  }

  if (!waSessionManager.isConnected(row.channelId)) {
    return delayJob(job, token, HumanizerService.between(45_000, 120_000));
  }

  const lock = await acquireLock(row.channelId);
  if (!lock) return delayJob(job, token, HumanizerService.between(2_000, 6_000));

  try {
    await sendWhileLocked(job, token, row, ctx);
  } finally {
    await releaseLock(row.channelId, lock);
  }
}

async function sendWhileLocked(
  job: Job<OutboundJobData>,
  token: string | undefined,
  row: ChannelMessage,
  ctx: ChannelContext,
): Promise<void> {
  const isStatus = row.kind === 'STATUS_TEXT' || row.kind === 'STATUS_IMAGE';

  const intent: SendIntent = {
    recipient: row.toAddress,
    isGroup: isGroupJid(row.toAddress),
    isStatus,
    origin: row.automationId ? 'AUTOMATION' : 'API',
    fingerprint: contentFingerprint(row.content ?? row.media?.sourceUrl ?? ''),
  };

  const decision = await OutboundPolicy.evaluate(ctx, intent);

  if (decision.action === 'REJECT') {
    await markFailed(row.id, decision.code);
    return;
  }
  if (decision.action === 'DELAY') return delayJob(job, token, decision.delayMs);

  const sock = waSessionManager.getSocket(row.channelId);
  if (!sock) return delayJob(job, token, 60_000);

  // Claim: only the one who flips QUEUED to SENDING may send. A cancel that landed meanwhile wins.
  const [claimed] = await db
    .update(channelMessages)
    .set({ deliveryStatus: 'SENDING', attempts: sql`${channelMessages.attempts} + 1` })
    .where(and(eq(channelMessages.id, row.id), eq(channelMessages.deliveryStatus, 'QUEUED')))
    .returning({ id: channelMessages.id });

  if (!claimed) return;

  try {
    if (decision.verifyRecipient && !(await MessageService.isOnWhatsApp(sock, row.toAddress))) {
      await markFailed(row.id, 'NOT_ON_WHATSAPP');
      return;
    }

    const externalMessageId = await deliver(sock, row, ctx);

    await db
      .update(channelMessages)
      .set({ deliveryStatus: 'SENT', externalMessageId, sentAt: new Date(), failureReason: null })
      .where(eq(channelMessages.id, row.id));

    await OutboundPolicy.recordSent(ctx, intent, decision);
  } catch (error) {
    await handleSendError(row, error);
  }
}

async function deliver(sock: WASocket, row: ChannelMessage, ctx: ChannelContext): Promise<string> {
  const jid = row.toAddress;
  const text = row.content ?? '';
  const pasted = row.automationId !== null; // a prepared announcement is pasted, not typed
  const humanize = ctx.settings.humanize;
  const payload = row.payload ?? {};

  switch (row.kind) {
    case 'TEXT': {
      if (humanize) await HumanizerService.simulateHumanTyping(sock, jid, text, { pasted });
      return MessageService.sendText(sock, jid, text, row.mentions);
    }

    case 'IMAGE': {
      const source = row.media?.sourceUrl;
      if (!source) throw ApiError.badRequest('The image source is missing.', 'MISSING_IMAGE');

      const image = await fetchImageSafely(source); // validated again now, not only when accepted
      if (humanize) await HumanizerService.simulateHumanTyping(sock, jid, text, { pasted: true });
      return MessageService.sendImage(sock, jid, image.buffer, text || undefined);
    }

    case 'STATUS_TEXT':
    case 'STATUS_IMAGE': {
      const audience = await OutboundService.resolveStatusAudience(row.channelId, payload.audience);
      if (audience.length === 0) {
        throw ApiError.badRequest('Nobody can see this status yet: no recent contacts.', 'EMPTY_STATUS_AUDIENCE');
      }
      if (humanize) await HumanizerService.sleep(HumanizerService.between(1_500, 5_000));

      if (row.kind === 'STATUS_TEXT') {
        return MessageService.sendStatusText(sock, text, audience, {
          backgroundColor: payload.backgroundColor,
          font: payload.font,
        });
      }

      const source = row.media?.sourceUrl;
      if (!source) throw ApiError.badRequest('The image source is missing.', 'MISSING_IMAGE');
      const image = await fetchImageSafely(source);
      return MessageService.sendStatusImage(sock, image.buffer, text || undefined, audience);
    }

    default:
      throw ApiError.badRequest('This message type cannot be sent.', 'UNSUPPORTED_KIND');
  }
}

async function handleSendError(row: ChannelMessage, error: unknown): Promise<never> {
  const kind = OutboundPolicy.classifyError(error);
  await OutboundPolicy.recordFailure(row.channelId, kind);

  // Our own validation errors are final, except a download that may simply have hiccuped.
  const finalApiError = error instanceof ApiError && errorCode(error) !== 'IMAGE_FETCH_FAILED';

  if (kind === 'PERMANENT' || kind === 'LOGGED_OUT' || finalApiError) {
    await markFailed(row.id, reasonOf(error));
    throw new UnrecoverableError(reasonOf(error));
  }

  // Temporary trouble: give the message back so the retry can claim it again.
  await db
    .update(channelMessages)
    .set({ deliveryStatus: 'QUEUED', failureReason: reasonOf(error) })
    .where(and(eq(channelMessages.id, row.id), eq(channelMessages.deliveryStatus, 'SENDING')));

  throw error;
}

/* ============================================================================
 * MARK_READ and STATUS_VIEW: small, cosmetic, never worth failing loudly
 * ========================================================================== */

async function processMarkRead(
  job: Job<OutboundJobData>,
  token: string | undefined,
  channelId: string,
  chatJid: string,
): Promise<void> {
  const sock = waSessionManager.getSocket(channelId);

  if (!sock || !waSessionManager.isConnected(channelId)) {
    if (Date.now() - job.timestamp > MAX_HOUSEKEEPING_AGE_MS) return; // too late to be believable
    return delayJob(job, token, 60_000);
  }

  const listKey = `wa:readq:${channelId}:${chatJid}`;
  const raw = await redis.lrange(listKey, 0, 99);
  if (raw.length === 0) return;
  await redis.ltrim(listKey, raw.length, -1); // remove only what we read; a message that arrived meanwhile stays

  const keys = raw.flatMap((item) => {
    try {
      const parsed = JSON.parse(item) as { id?: unknown; participant?: unknown };
      return typeof parsed.id === 'string'
        ? [{ id: parsed.id, remoteJid: chatJid, participant: typeof parsed.participant === 'string' ? parsed.participant : null }]
        : [];
    } catch {
      return [];
    }
  });

  try {
    await MessageService.markRead(sock, keys);
  } catch (error) {
    console.warn(`⚠️ [Worker] Read receipt skipped: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
}

async function processStatusView(
  job: Job<OutboundJobData>,
  token: string | undefined,
  data: Extract<OutboundJobData, { type: 'STATUS_VIEW' }>,
): Promise<void> {
  const policy = await AutomationService.getStatusViewPolicy(data.channelId);
  if (!policy) return; // the customer turned it off after this was scheduled

  const ctx = await OutboundPolicy.loadContext(data.channelId);
  if (!ctx) return;

  const sock = waSessionManager.getSocket(data.channelId);
  if (!sock || !waSessionManager.isConnected(data.channelId)) {
    if (Date.now() - job.timestamp > MAX_HOUSEKEEPING_AGE_MS * 3) return;
    return delayJob(job, token, 5 * 60_000);
  }

  if (!(await OutboundPolicy.allowStatusView(ctx, policy.maxPerDay))) return;

  try {
    await MessageService.markRead(sock, [{ id: data.statusId, remoteJid: STATUS_JID, participant: data.posterJid }]);
  } catch (error) {
    console.warn(`⚠️ [Worker] Status view skipped: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
}

/* ============================================================================
 * Worker lifecycle
 * ========================================================================== */

async function processJob(job: Job<OutboundJobData>, token?: string): Promise<void> {
  const data = job.data;

  switch (data.type) {
    case 'MESSAGE':
      return processMessage(job, token, data.messageId);
    case 'MARK_READ':
      return processMarkRead(job, token, data.channelId, data.chatJid);
    case 'STATUS_VIEW':
      return processStatusView(job, token, data);
  }
}

let worker: Worker<OutboundJobData> | null = null;

export function startOutboundWorker(): void {
  if (worker) return;

  worker = new Worker<OutboundJobData>(OUTBOUND_QUEUE, processJob, {
    connection: createQueueConnection(),
    concurrency: Number(process.env.OUTBOUND_WORKER_CONCURRENCY ?? 10),
  });

  worker.on('error', (error) => console.error('❌ [Worker] Queue error:', error.message));

  // When retries are used up (or the failure is final), the message row must say so.
  worker.on('failed', (job, error) => {
    if (!job || job.data.type !== 'MESSAGE') return;

    const final = error instanceof UnrecoverableError || job.attemptsMade >= (job.opts.attempts ?? 1);
    if (final) void markFailed(job.data.messageId, reasonOf(error));
  });

  console.log('🛠️ [Worker] Outbound worker started.');
}

export async function stopOutboundWorker(): Promise<void> {
  await worker?.close();
  worker = null;
}