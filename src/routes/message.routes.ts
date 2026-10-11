// path: src/routes/message.routes.ts

import { Router } from 'express';
import { MessageController } from '../controllers/message.controller.js';
import { requirePermission } from '../middlewares/auth.middleware.js';
import { rateLimit } from '../middlewares/rate-limit.middleware.js';
import { validate } from '../middlewares/validate-request.middleware.js';
import { messageSchema } from '../schemas/message.schema.js';

/**
 * Messages of ONE channel. Attached by channel.routes.ts, behind authenticate and requireOrganization().
 *
 * Sending is asynchronous: POST returns 202 with a message id, the worker sends later at a human pace,
 * and GET shows the progress (QUEUED, SENDING, SENT, FAILED, CANCELLED). The per-minute limit here only
 * protects the API; the real, per-number limits (warm-up, daily caps, pacing) are enforced by the worker.
 */
const router = Router({ mergeParams: true });

const sendLimit = rateLimit({
  name: 'message-send',
  limit: 120,
  windowSeconds: 60,
  keyBy: (req) => String(req.params.channelId),
});

/** @route POST .../channels/:channelId/messages  Body: { kind: 'TEXT'|'IMAGE', to, ... }. Header: Idempotency-Key. @access message:send */
router.post('/:channelId/messages', sendLimit, requirePermission('message:send'), validate(messageSchema.send), MessageController.send);

/** @route GET .../channels/:channelId/messages  Newest first. Page with ?before=<nextBefore>. @access channel:read */
router.get('/:channelId/messages', requirePermission('channel:read'), validate(messageSchema.list), MessageController.list);

router.get('/:channelId/messages/:messageId', requirePermission('channel:read'), validate(messageSchema.get), MessageController.get);

/** Cancels a message that has not started sending. @access message:send */
router.delete('/:channelId/messages/:messageId', requirePermission('message:send'), validate(messageSchema.cancel), MessageController.cancel);

export default router;