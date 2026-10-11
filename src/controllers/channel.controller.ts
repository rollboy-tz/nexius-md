// path: src/controllers/channel.controller.ts

import type { Request } from 'express';
import { getAuthUser, getOrgContext } from '../middlewares/auth.middleware.js';
import { bodyOf, paramsOf, queryOf } from '../middlewares/validate-request.middleware.js';
import type { ChannelParams } from '../schemas/wa-session.schema.js';
import type { CreateChannelBody, ListContactsQuery, ListGroupsQuery, RenameChannelBody, UpdateChannelSettingsBody } from '../schemas/channel.schema.js';
import { ChannelService, type ChannelActor } from '../services/channel.service.js';
import { DirectoryService } from '../services/directory.service.js';
import { catchAsync } from '../utils/catch-async.util.js';
import { metaOf } from '../utils/request-meta.js';
import { ApiResponse } from '../utils/api-response.util.js'; // adjust to where your ApiResponse lives

/** The caller as the service layer wants to see them: who, and with which role in THIS organization. */
function actorOf(req: Request): ChannelActor {
  return { userId: getAuthUser(req).userId, role: getOrgContext(req).role };
}

/**
 * Creating a channel only reserves a slot (plan limit enforced under a row lock). It does not touch
 * WhatsApp. The returned `id` is what the session routes and the live-log room use:
 *
 *   POST /organizations/:organizationId/channels                    -> { id, status: 'PENDING', ... }
 *   POST /organizations/:organizationId/channels/:channelId/initiate
 *   POST /organizations/:organizationId/channels/:channelId/pair
 */
export const ChannelController = {
  create: catchAsync(async (req, res) => {
    const { organizationId } = getOrgContext(req);
    const channel = await ChannelService.create(organizationId, actorOf(req), bodyOf<CreateChannelBody>(req), metaOf(req));

    return ApiResponse.success(res, 'Channel created.', channel);
  }),

  /** Groups this number is in (live from WhatsApp, cached for a minute). */
  groups: catchAsync(async (req, res) => {
    const { organizationId } = getOrgContext(req);
    const { channelId } = paramsOf<ChannelParams>(req);
    const { refresh } = queryOf<ListGroupsQuery>(req);
    return ApiResponse.success(res, 'Groups.', await DirectoryService.listGroups(organizationId, channelId, refresh));
  }),

  /** People this number has exchanged messages with, newest first. */
  contacts: catchAsync(async (req, res) => {
    const { organizationId } = getOrgContext(req);
    const { channelId } = paramsOf<ChannelParams>(req);
    return ApiResponse.success(res, 'Contacts.', await DirectoryService.listContacts(organizationId, channelId, queryOf<ListContactsQuery>(req)));
  }),

  list: catchAsync(async (req, res) => {
    const { organizationId } = getOrgContext(req);
    return ApiResponse.success(res, 'Channels.', await ChannelService.list(organizationId));
  }),

  get: catchAsync(async (req, res) => {
    const { organizationId } = getOrgContext(req);
    const { channelId } = paramsOf<ChannelParams>(req);

    return ApiResponse.success(res, 'Channel.', await ChannelService.get(organizationId, channelId));
  }),

  rename: catchAsync(async (req, res) => {
    const { organizationId } = getOrgContext(req);
    const { channelId } = paramsOf<ChannelParams>(req);
    const { displayName } = bodyOf<RenameChannelBody>(req);

    const channel = await ChannelService.rename(organizationId, actorOf(req), channelId, displayName, metaOf(req));
    return ApiResponse.success(res, 'Channel renamed.', channel);
  }),

  /** Soft delete: the live session is stopped and its stored credentials are destroyed. */
  remove: catchAsync(async (req, res) => {
    const { organizationId } = getOrgContext(req);
    const { channelId } = paramsOf<ChannelParams>(req);

    await ChannelService.remove(organizationId, actorOf(req), channelId, metaOf(req));
    return ApiResponse.success(res, 'Channel deleted.', null);
  }),

  /** Makes the number more careful (time zone, working hours, cold outreach, humanising, lower daily cap). */
  updateSettings: catchAsync(async (req, res) => {
    const { organizationId } = getOrgContext(req);
    const { channelId } = paramsOf<ChannelParams>(req);

    const channel = await ChannelService.updateSettings(
      organizationId,
      actorOf(req),
      channelId,
      bodyOf<UpdateChannelSettingsBody>(req),
      metaOf(req),
    );
    return ApiResponse.success(res, 'Settings updated.', channel);
  }),
};
