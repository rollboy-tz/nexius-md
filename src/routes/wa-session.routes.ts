// path: src/routes/wa-session.routes.ts

import { Router } from 'express';
import { WASessionController } from '../controllers/wa-session.controller.js';
import { requirePermission } from '../middlewares/auth.middleware.js';
import { validate } from '../middlewares/validate-request.middleware.js';
import { sessionSchema } from '../schemas/wa-session.schema.js';

/**
 * Live WhatsApp session operations for ONE channel. Attached by channel.routes.ts, which sits
 * behind authenticate and requireOrganization(), so this file only adds, per route:
 *   requirePermission   does their role allow this action
 *   validate            Zod checks of params and body (unknown fields are rejected)
 * and each handler then resolves the channel INSIDE the caller's organization, so a channel id
 * belonging to another tenant is simply "not found".
 */
const router = Router({ mergeParams: true });

/** @route GET .../channels/:channelId/status   Live state (state, connected flag, WhatsApp profile). @access channel:read */
router.get('/:channelId/status', requirePermission('channel:read'), validate(sessionSchema.status), WASessionController.status);

/**
 * @route POST .../channels/:channelId/initiate
 * Starts (or reuses) the connection and returns at once. Progress arrives through the
 * 'session_status' / 'session_log' Socket.IO events. Optional body: { phoneNumber }. @access channel:manage
 */
router.post(
  '/:channelId/initiate',
  requirePermission('channel:manage'),
  validate(sessionSchema.initiate),
  WASessionController.initiate,
);

/**
 * @route POST .../channels/:channelId/pair
 * Returns a pairing code. Can take ~30s while the server retries transient WhatsApp errors, so the
 * client timeout must be longer. Body: { phoneNumber }. @access channel:manage
 */
router.post('/:channelId/pair', requirePermission('channel:manage'), validate(sessionSchema.pair), WASessionController.pair);

/** @route POST .../channels/:channelId/disconnect   Stops the connection; credentials stay. @access channel:manage */
router.post(
  '/:channelId/disconnect',
  requirePermission('channel:manage'),
  validate(sessionSchema.disconnect),
  WASessionController.disconnect,
);

/** @route POST .../channels/:channelId/messages   Body: { to, text }. @access message:send */
router.post(
  '/:channelId/messages',
  requirePermission('message:send'),
  validate(sessionSchema.sendMessage),
  WASessionController.sendMessage,
);

export default router;