import type { Request, Response } from 'express';
import { catchAsync } from '../utils/catch-async.util.js';
import { ApiResponse } from '../utils/api-response.util.js';
import { sessionManager } from '../services/session.manager.js';
import { ApiError } from '../utils/api.error.js';
import { prisma } from '../config/database.js';
import { env } from '../config/env.js';

/**
 * Internal helper to log verbose debug information strictly during development mode.
 */
function logDevDebug(tag: string, message: string, metadata?: unknown): void {
  if (env.NODE_ENV !== 'development') return;

  const timestamp = new Date().toISOString();

  if (metadata !== undefined) {
    console.log(`\x1b[33m[DEV-CONTROLLER ${timestamp}] [${tag}]\x1b[0m ${message}`, metadata);
  } else {
    console.log(`\x1b[33m[DEV-CONTROLLER ${timestamp}] [${tag}]\x1b[0m ${message}`);
  }
}

/**
 * Enterprise Session Controller handling WhatsApp socket lifecycle operations,
 * pairing code requests, status checks, listing, and message dispatches.
 */
export class SessionController {
  /**
   * Starts (or resumes) establishing a WhatsApp socket for a session and
   * returns IMMEDIATELY — it does not wait for the socket to actually
   * connect. Deliberately non-blocking: waiting here would tie up this HTTP
   * request for however long WhatsApp takes to respond, with no upper bound
   * the client controls, and risks the request dying to a proxy/client
   * timeout before the socket has even connected. Clients should track
   * progress via the 'session_status' Socket.IO event, or poll
   * GET /:sessionId/status.
   *
   * @route POST /api/v1/sessions/start
   */
  public initiateSession = catchAsync(async (req: Request, res: Response) => {
    const { sessionId, phoneNumber } = req.body as { sessionId?: string; phoneNumber?: string };

    if (!sessionId) {
      throw ApiError.badRequest('sessionId is required to start a session.', 'MISSING_SESSION_ID');
    }

    logDevDebug('START_SESSION', `Starting session in the background: ${sessionId}`);

    // Fire-and-forget on purpose. Failures that happen after this response
    // has already been sent are reported through the existing
    // 'session_status' Socket.IO events emitted by bailey.service.js, not
    // through this HTTP response.
    void sessionManager.getOrCreateSession(sessionId, phoneNumber).catch((err) => {
      console.error(`[SessionController] Background session start failed for '${sessionId}':`, err);
    });

    // Using res directly (not ApiResponse.success) because this is the one
    // endpoint that must return 202, not 200 — check whether
    // ApiResponse.success supports a status code override; if it does,
    // switch this back to match the other methods below.
    res.status(202).json({
      success: true,
      message: 'Session start initiated. Track progress via Socket.IO or GET /:sessionId/status.',
      data: { sessionId },
    });
  });

  /**
   * Requests a WhatsApp pairing code for a session that has already been
   * started via /start. This call is allowed to block — up to the internal
   * 30s deadline inside requestPairingCodeSafely() — because the pairing
   * code itself is the thing the caller actually needs back. It no longer
   * also pays the cost of first-time socket creation on top of that
   * deadline, since /start already began that separately.
   *
   * @route POST /api/v1/sessions/pair
   */
  public requestPairing = catchAsync(async (req: Request, res: Response) => {
    const { sessionId, phoneNumber } = req.body as { sessionId?: string; phoneNumber?: string };

    if (!sessionId || !phoneNumber) {
      throw ApiError.badRequest(
        'Both sessionId and phoneNumber are required to request a pairing code.',
        'MISSING_REQUIRED_FIELDS',
      );
    }

    logDevDebug('REQUEST_PAIRING', `Initiating pairing code request for session: ${sessionId}`);

    const pairingCode = await sessionManager.requestPairingCode(sessionId, phoneNumber);

    return ApiResponse.success(res, 'WhatsApp pairing code generated successfully.', {
      sessionId,
      phoneNumber,
      pairingCode,
    });
  });

  /**
   * Fetches database status and socket runtime state for a specific session.
   *
   * @route GET /api/v1/sessions/:sessionId/status
   */
  public getStatus = catchAsync(async (req: Request, res: Response) => {
    const { sessionId } = req.params as { sessionId: string };

    if (!sessionId) {
      throw ApiError.badRequest('Session ID parameter is required.', 'MISSING_SESSION_ID');
    }

    logDevDebug('GET_STATUS', `Fetching runtime and database status for session: ${sessionId}`);

    const dbSession = await prisma.session.findUnique({
      where: { id: sessionId },
    });

    if (!dbSession) {
      throw ApiError.notFound(`Session with ID '${sessionId}' was not found in the database.`, 'SESSION_NOT_FOUND');
    }

    const isMemoryActive = sessionManager.isSessionActive(sessionId);
    const activeSocket = sessionManager.getSession(sessionId);

    return ApiResponse.success(res, 'Session status retrieved successfully.', {
      session: dbSession,
      isMemoryActive,
      userJid: activeSocket?.user?.id ?? null,
      pushName: activeSocket?.user?.name ?? activeSocket?.user?.notify ?? null,
    });
  });

  /**
   * Retrieves a list of all database sessions alongside total active in-memory sessions count.
   *
   * @route GET /api/v1/sessions
   */
  public listSessions = catchAsync(async (_req: Request, res: Response) => {
    logDevDebug('LIST_SESSIONS', 'Listing all registered database sessions');

    const sessions = await prisma.session.findMany({
      orderBy: { updatedAt: 'desc' },
    });

    return ApiResponse.success(res, 'Registered sessions fetched successfully.', {
      totalRegistered: sessions.length,
      activeInMemoryCount: sessionManager.getActiveSessionsCount(),
      sessions,
    });
  });

  /**
   * Sends an outbound text message through an active WhatsApp session.
   *
   * @route POST /api/v1/sessions/send-message
   */
  public sendMessage = catchAsync(async (req: Request, res: Response) => {
    const { sessionId, to, text } = req.body as { sessionId?: string; to?: string; text?: string };

    if (!sessionId || !to || !text) {
      throw ApiError.badRequest(
        'sessionId, recipient (to), and message content (text) are required.',
        'MISSING_REQUIRED_FIELDS',
      );
    }

    logDevDebug('SEND_MESSAGE', `Dispatching message via session: ${sessionId} to: ${to}`);

    const sentMessage = await sessionManager.sendMessage({ sessionId, to, text });

    return ApiResponse.success(res, 'WhatsApp message dispatched successfully.', {
      sessionId,
      messageId: sentMessage?.key.id ?? null,
      timestamp: sentMessage?.messageTimestamp ?? null,
    });
  });

  /**
   * Terminates and unregisters a WhatsApp socket session safely from memory and updates database state.
   *
   * @route DELETE /api/v1/sessions/:sessionId
   */
  public deleteSession = catchAsync(async (req: Request, res: Response) => {
    const { sessionId } = req.params as { sessionId: string };

    if (!sessionId) {
      throw ApiError.badRequest('Session ID parameter is required.', 'MISSING_SESSION_ID');
    }

    logDevDebug('DELETE_SESSION', `Terminating session and updating database for: ${sessionId}`);

    const dbSession = await prisma.session.findUnique({
      where: { id: sessionId },
    });

    if (!dbSession) {
      throw ApiError.notFound(`Session '${sessionId}' does not exist or has already been removed.`, 'SESSION_NOT_FOUND');
    }

    await sessionManager.removeSession(sessionId);

    const updatedSession = await prisma.session.update({
      where: { id: sessionId },
      data: { status: 'DISCONNECTED' },
    });

    return ApiResponse.success(res, `Session '${sessionId}' disconnected and unlinked successfully.`, {
      session: updatedSession,
    });
  });
}

/** Export singleton instance reference */
export const sessionController = new SessionController();