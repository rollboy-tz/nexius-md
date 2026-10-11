// path: src/routes/channel.routes.ts

import { Router } from 'express';
import { ChannelController } from '../controllers/channel.controller.js';
import { requirePermission } from '../middlewares/auth.middleware.js';
import { validate } from '../middlewares/validate-request.middleware.js';
import { channelSchema } from '../schemas/channel.schema.js';
import messageRoutes from './message.routes.js';
import waSessionRoutes from './wa-session.routes.js';

/**
 * Channels of ONE organization. Mounted by organization.routes.ts at
 *   /api/v1/organizations/:organizationId/channels
 * AFTER authenticate and requireOrganization(), so those two run exactly once per request and
 * every handler here can rely on req.user and req.org.
 *
 * Session operations (initiate, pair, status, disconnect, messages) live in wa-session.routes.ts
 * and are attached at the bottom, so one URL tree serves both.
 */
const router = Router({ mergeParams: true });

/** @access channel:read */
router.get('/', requirePermission('channel:read'), validate(channelSchema.list), ChannelController.list);

/** Reserves a slot (plan limit enforced) and returns the channel id used by every session route. @access channel:create */
router.post('/', requirePermission('channel:create'), validate(channelSchema.create), ChannelController.create);

/** Pickers for automations: groups (live) and recent contacts (from history). @access channel:read */
router.get('/:channelId/groups', requirePermission('channel:read'), validate(channelSchema.groups), ChannelController.groups);
router.get('/:channelId/contacts', requirePermission('channel:read'), validate(channelSchema.contacts), ChannelController.contacts);

router.get('/:channelId', requirePermission('channel:read'), validate(channelSchema.get), ChannelController.get);

router.patch('/:channelId', requirePermission('channel:manage'), validate(channelSchema.rename), ChannelController.rename);

router.delete('/:channelId', requirePermission('channel:delete'), validate(channelSchema.remove), ChannelController.remove);

/** Safety settings: time zone, working hours, cold outreach, humanising, a lower daily cap. @access channel:manage */
router.patch(
  '/:channelId/settings',
  requirePermission('channel:manage'),
  validate(channelSchema.updateSettings),
  ChannelController.updateSettings,
);

router.use(messageRoutes);
router.use(waSessionRoutes);

export default router;
