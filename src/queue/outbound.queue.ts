// path: src/queue/outbound.queue.ts

import { Queue, type ConnectionOptions } from 'bullmq';
import { redis } from '../config/redis.js';

/**
 * The producer half of the outbound queue. It deliberately imports nothing about WhatsApp sockets,
 * so the code that receives messages (inbound.service) and the code that accepts API calls
 * (outbound.service) can enqueue work without a circular import. The consumer is outbound.worker.ts.
 *
 * Dedicated connections: BullMQ needs maxRetriesPerRequest = null, which the shared client does not use.
 * Cost note: BullMQ polls Redis. On a pay-per-command service (Upstash free/pay-as-you-go) that adds up;
 * use a fixed-price or self-hosted Redis for the queue.
 */

export const OUTBOUND_QUEUE = 'wa-outbound';

export type OutboundJobData =
  /** Send a message that already exists as a QUEUED row. */
  | { type: 'MESSAGE'; messageId: string }
  /** Mark the pending messages of one chat as read (blue ticks), some time after they arrived. */
  | { type: 'MARK_READ'; channelId: string; chatJid: string }
  /** Look at one status update, some time after it was posted. */
  | { type: 'STATUS_VIEW'; channelId: string; posterJid: string; statusId: string };

export function createQueueConnection(): ConnectionOptions {
  return redis.duplicate({ maxRetriesPerRequest: null, enableReadyCheck: false });
}

let queue: Queue<OutboundJobData> | null = null;

export function getOutboundQueue(): Queue<OutboundJobData> {
  queue ??= new Queue<OutboundJobData>(OUTBOUND_QUEUE, {
    connection: createQueueConnection(),
    defaultJobOptions: {
      attempts: 4,
      backoff: { type: 'exponential', delay: 30_000 },
      removeOnComplete: { age: 3600, count: 2000 },
      removeOnFail: { age: 7 * 24 * 3600, count: 5000 },
    },
  });
  return queue;
}

/** BullMQ rejects custom job ids that contain ':'. */
const safeId = (value: string): string => value.replace(/[^a-zA-Z0-9@._-]/g, '_');

/** Interactive replies go first; bulk and scheduled work waits behind them. Lower number = sooner. */
const PRIORITY = { INTERACTIVE: 1, BULK: 10 } as const;

export async function enqueueMessageJob(
  messageId: string,
  options: { delayMs?: number | undefined; priority?: keyof typeof PRIORITY | undefined } = {},
): Promise<void> {
  await getOutboundQueue().add(
    'message',
    { type: 'MESSAGE', messageId },
    {
      jobId: messageId, // one job per message: adding twice is harmless
      delay: Math.max(0, options.delayMs ?? 0),
      priority: PRIORITY[options.priority ?? 'BULK'],
    },
  );
}

/** Keys of unread messages are kept in a Redis list, so a burst of messages becomes ONE read, like a person opening the chat. */
export async function enqueueMarkRead(
  channelId: string,
  chatJid: string,
  key: { id: string; participant?: string | null | undefined },
  delayMs: number,
): Promise<void> {
  const listKey = `wa:readq:${channelId}:${chatJid}`;

  await redis.rpush(listKey, JSON.stringify({ id: key.id, participant: key.participant ?? null }));
  await redis.expire(listKey, 3 * 3600);

  await getOutboundQueue().add(
    'mark-read',
    { type: 'MARK_READ', channelId, chatJid },
    { jobId: `read-${safeId(channelId)}-${safeId(chatJid)}`, delay: delayMs, priority: PRIORITY.INTERACTIVE, attempts: 2 },
  );
}

export async function enqueueStatusView(
  channelId: string,
  posterJid: string,
  statusId: string,
  delayMs: number,
): Promise<void> {
  await getOutboundQueue().add(
    'status-view',
    { type: 'STATUS_VIEW', channelId, posterJid, statusId },
    { jobId: `sv-${safeId(channelId)}-${safeId(statusId)}`, delay: delayMs, priority: PRIORITY.BULK, attempts: 2 },
  );
}

/** Best effort: a job that is already running cannot be removed, which is why the message row is the source of truth. */
export async function removeJob(jobId: string): Promise<void> {
  try {
    await (await getOutboundQueue().getJob(jobId))?.remove();
  } catch {
    // active or already gone
  }
}

export async function closeOutboundQueue(): Promise<void> {
  await queue?.close();
  queue = null;
}