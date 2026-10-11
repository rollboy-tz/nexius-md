// path: src/schemas/message.schema.ts

import { z } from 'zod';

const uuid = z.string().uuid('Invalid id');
const channelParams = z.object({ organizationId: uuid, channelId: uuid });
const messageParams = z.object({ organizationId: uuid, channelId: uuid, messageId: uuid });

/** The number or group to write to. utils/jid.util decides what is acceptable. */
const to = z.string().trim().min(1).max(128);

/** Optional: send later (at most 30 days ahead). A time in the past just means "as soon as the rules allow". */
const scheduledFor = z.coerce.date().optional();

/** Text may carry WhatsApp formatting: *bold*, _italic_, ~strike~, `code`, ```blocks```, links, @mentions. It is kept exactly. */
const text = z.string().min(1, 'Message cannot be empty').max(4096, 'Message is too long');

export const messageSchema = {
  /**
   * One endpoint, one shape per kind. Video and voice are not accepted in this version, so they
   * simply do not exist here: a request for them fails validation.
   */
  send: {
    params: channelParams,
    body: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('TEXT'), to, text, scheduledFor }).strict(),
      z
        .object({
          kind: z.literal('IMAGE'),
          to,
          /** https only. The server downloads it itself, safely, when the message is sent. */
          imageUrl: z.string().trim().url().max(2048),
          caption: z.string().max(1024).optional(),
          scheduledFor,
        })
        .strict(),
    ]),
  },

  get: { params: messageParams },

  list: {
    params: channelParams,
    query: z.object({
      deliveryStatus: z.enum(['QUEUED', 'SENDING', 'SENT', 'FAILED', 'CANCELLED', 'RECEIVED']).optional(),
      direction: z.enum(['INBOUND', 'OUTBOUND']).optional(),
      /** Page backwards: pass the `nextBefore` you were given. */
      before: z.coerce.date().optional(),
      limit: z.coerce.number().int().min(1).max(100).optional(),
    }),
  },

  cancel: { params: messageParams },
};

export type SendMessageBody = z.infer<typeof messageSchema.send.body>;
export type MessageParams = z.infer<typeof messageSchema.get.params>;
export type ListMessagesQuery = z.infer<typeof messageSchema.list.query>;