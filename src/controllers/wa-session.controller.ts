// path: src/controllers/wa-session.controller.ts

import type { Request, Response } from 'express';
import { getAuthUser, getOrgContext } from '../middlewares/auth.middleware.js';
import { AuditService, type RequestMeta } from '../services/audit.service.js';
import { isUuid } from '../services/auth-session.service.js';
import { ChannelService, type ChannelView } from '../services/channel.service.js';
import { waSessionManager } from '../services/wa-session.manager.js';
import { ApiError } from '../utils/api.error.js';
import { catchAsync } from '../utils/catch-async.util.js';
import { ApiResponse } from '../utils/api-response.util.js';

/* ============================================================================
 * Small, local request helpers (no extra dependency)
 * ========================================================================== */

const metaOf = (req: Request): RequestMeta => ({
  ipAddress: req.ip || req.socket.remoteAddress || 'unknown',
  userAgent: req.get('user-agent'),
  requestId: req.get('x-request-id'),
});

function bodyOf(req: Request): Record<string, unknown> {
  return req.body && typeof req.body === 'object' && !Array.isArray(req.body)
    ? (req.body as Record<string, unknown>)
    : {};
}

function requiredString(body: Record<string, unknown>, key: string, maxLength: number): string {
  const value = body[key];

  if (typeof value !== 'string' || value.trim().length === 0) {
    throw ApiError.badRequest(`"${key}" is required.`, 'VALIDATION_ERROR');
  }
  if (value.length > maxLength) {
    throw ApiError.badRequest(`"${key}" is too long.`, 'VALIDATION_ERROR');
  }
  return value;
}

function optionalString(body: Record<string, unknown>, key: string, maxLength: number): string | undefined {
  return body[key] === undefined || body[key] === null ? undefined : requiredString(body, key, maxLength);
}

/**
 * The guard every handler starts with. The channel is looked up INSIDE the caller's organization,
 * so a valid channel id from another tenant is "not found", never reachable.
 */
async function resolveChannel(req: Request): Promise<ChannelView> {
  const { organizationId } = getOrgContext(req);
  const channelId: unknown = req.params.channelId;

  if (!isUuid(channelId)) throw ApiError.notFound('Channel not found.', 'CHANNEL_NOT_FOUND');

  const channel = await ChannelService.get(organizationId, channelId);
  if (channel.provider !== 'WHATSAPP') {
    throw ApiError.badRequest('This channel is not a WhatsApp channel.', 'WRONG_PROVIDER');
  }
  return channel;
}

/* ============================================================================
 * Routes (mount under /organizations/:organizationId/channels/:channelId)
 *
 *   POST   /initiate     authenticate, requireOrganization(), requirePermission('channel:manage')
 *   POST   /pair         ... 'channel:manage'
 *   POST   /disconnect   ... 'channel:manage'
 *   GET    /status       ... 'channel:read'
 *   POST   /messages     ... 'message:send'
 * ========================================================================== */

export const WASessionController = {
  /** Starts (or reuses) the connection. Progress arrives live through Socket.IO. */
  initiate: catchAsync(async (req: Request, res: Response) => {
    const user = getAuthUser(req);
    const org = getOrgContext(req);
    const channel = await resolveChannel(req);

    await waSessionManager.getOrCreateSession(channel.id, optionalString(bodyOf(req), 'phoneNumber', 32));

    await AuditService.recordBestEffort({
      organizationId: org.organizationId,
      actorUserId: user.userId,
      action: 'channel.connect_requested',
      targetType: 'channel',
      targetId: channel.id,
      meta: metaOf(req),
    });

    return ApiResponse.success(res, 'Session is starting.', waSessionManager.getStatus(channel.id));
  }),

  /** Returns the pairing code. Never cached: it is a one-time credential for the owner's WhatsApp. */
  pair: catchAsync(async (req: Request, res: Response) => {
    const user = getAuthUser(req);
    const org = getOrgContext(req);
    const channel = await resolveChannel(req);
    const phoneNumber = requiredString(bodyOf(req), 'phoneNumber', 32);

    const pairingCode = await waSessionManager.requestPairingCode(channel.id, phoneNumber);

    await AuditService.recordBestEffort({
      organizationId: org.organizationId,
      actorUserId: user.userId,
      action: 'channel.pairing_requested',
      targetType: 'channel',
      targetId: channel.id,
      meta: metaOf(req),
    });

    res.setHeader('Cache-Control', 'no-store');
    return ApiResponse.success(res, 'Pairing code generated.', { pairingCode });
  }),

  /** Stops the live connection. Stored credentials stay, so "initiate" brings it back without pairing. */
  disconnect: catchAsync(async (req: Request, res: Response) => {
    const user = getAuthUser(req);
    const org = getOrgContext(req);
    const channel = await resolveChannel(req);

    await waSessionManager.removeSession(channel.id);

    await AuditService.recordBestEffort({
      organizationId: org.organizationId,
      actorUserId: user.userId,
      action: 'channel.disconnected',
      targetType: 'channel',
      targetId: channel.id,
      meta: metaOf(req),
    });

    return ApiResponse.success(res, 'Session disconnected.', waSessionManager.getStatus(channel.id));
  }),

  /** Returns current session connection status. */
  status: catchAsync(async (req: Request, res: Response) => {
    const channel = await resolveChannel(req);
    return ApiResponse.success(res, 'Session status.', waSessionManager.getStatus(channel.id));
  }),

  /** Sends an outbound text message via WhatsApp session. */
  sendMessage: catchAsync(async (req: Request, res: Response) => {
    const org = getOrgContext(req);
    const channel = await resolveChannel(req);
    const body = bodyOf(req);

    const sent = await waSessionManager.sendMessage({
      organizationId: org.organizationId,
      sessionId: channel.id,
      to: requiredString(body, 'to', 128),
      text: requiredString(body, 'text', 4096),
    });

    return ApiResponse.success(res, 'Message sent.', sent);
  }),
};