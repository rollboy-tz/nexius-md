// path: src/controllers/message.controller.ts

import type { Request } from 'express';
import { getOrgContext } from '../middlewares/auth.middleware.js';
import { bodyOf, paramsOf, queryOf } from '../middlewares/validate-request.middleware.js';
import type { ListMessagesQuery, MessageParams, SendMessageBody } from '../schemas/message.schema.js';
import type { ChannelParams } from '../schemas/wa-session.schema.js';
import { ChannelService } from '../services/channel.service.js';
import { OutboundService } from '../services/outbound.service.js';
import { ApiError } from '../utils/api.error.js';
import { catchAsync } from '../utils/catch-async.util.js';
import { ApiResponse } from '../utils/api-response.util.js';


const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._-]{8,128}$/;

/** A client may send `Idempotency-Key: <unique id>`. Retrying with the same key can never create a second message. */
function idempotencyKeyOf(req: Request): string | undefined {
  const key = req.get('idempotency-key');
  if (key === undefined) return undefined;

  if (!IDEMPOTENCY_KEY_RE.test(key)) {
    throw ApiError.badRequest('Idempotency-Key must be 8 to 128 characters: letters, digits, dot, dash or underscore.', 'INVALID_IDEMPOTENCY_KEY');
  }
  return key;
}

export const MessageController = {
  /**
   * Accepts a message. It is NOT sent here: it is checked, stored as QUEUED and handed to the queue,
   * and goes out later at a human pace. The answer is 202 Accepted with the message id to follow.
   */
  send: catchAsync(async (req, res) => {
    const { organizationId } = getOrgContext(req);
    const { channelId } = paramsOf<ChannelParams>(req);
    const body = bodyOf<SendMessageBody>(req);

    // The channel must belong to this organization. A foreign id is "not found".
    await ChannelService.get(organizationId, channelId);

    const queued = await OutboundService.enqueue({
      organizationId,
      channelId,
      origin: 'API',
      to: body.to,
      content:
        body.kind === 'TEXT'
          ? { kind: 'TEXT', text: body.text }
          : { kind: 'IMAGE', imageUrl: body.imageUrl, caption: body.caption },
      scheduledFor: body.scheduledFor,
      idempotencyKey: idempotencyKeyOf(req),
    });

    return ApiResponse.accepted(res, queued.duplicate ? 'Message already accepted.' : 'Message accepted for sending.', queued);
  }),

  get: catchAsync(async (req, res) => {
    const { organizationId } = getOrgContext(req);
    const { channelId, messageId } = paramsOf<MessageParams>(req);

    return ApiResponse.success(res, 'Message.', await OutboundService.get(organizationId, channelId, messageId));
  }),

  list: catchAsync(async (req, res) => {
    const { organizationId } = getOrgContext(req);
    const { channelId } = paramsOf<ChannelParams>(req);

    return ApiResponse.success(res, 'Messages.', await OutboundService.list(organizationId, channelId, queryOf<ListMessagesQuery>(req)));
  }),

  /** Only a message that has not started sending can be cancelled. */
  cancel: catchAsync(async (req, res) => {
    const { organizationId } = getOrgContext(req);
    const { channelId, messageId } = paramsOf<MessageParams>(req);

    await OutboundService.cancel(organizationId, channelId, messageId);
    return ApiResponse.success(res, 'Message cancelled.', null);
  }),
};