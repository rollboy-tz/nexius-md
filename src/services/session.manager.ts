import { type WASocket } from '@whiskeysockets/baileys';
import {
  establishConnection,
  parseJidDetails,
  requestPairingCodeSafely,
  stopConnection,
  getSession as getManagedSession,
  getSessionState,
  getActiveSessionIds,
} from './bailey.service.js';
import { prisma } from '../config/database.js';
import { ApiError } from '../utils/api.error.js';
import { env } from '../config/env.js';
import { StatusCodes } from '../constants/status-codes.js';

/**
 * Interface representing message dispatch options.
 */
export interface SendMessagePayload {
  /** Target unique session identifier */
  sessionId: string;
  /** Recipient telephone number, User JID, or Group JID */
  to: string;
  /** Text content of the message */
  text: string;
}

/**
 * Internal helper to log verbose debug information strictly during development environment mode.
 */
function logDevDebug(tag: string, message: string, metadata?: unknown): void {
  if (env.NODE_ENV !== 'development') return;

  const timestamp = new Date().toISOString();

  if (metadata !== undefined) {
    console.log(`\x1b[35m[DEV-SESSION-MGR ${timestamp}] [${tag}]\x1b[0m ${message}`, metadata);
  } else {
    console.log(`\x1b[35m[DEV-SESSION-MGR ${timestamp}] [${tag}]\x1b[0m ${message}`);
  }
}

/**
 * Enterprise Singleton Session Manager for Baileys WhatsApp Sockets (Baileys v6.7.22).
 *
 * This class is DELIBERATELY thin. It holds no socket state of its own — the
 * single source of truth for "which socket is currently live for a session"
 * lives inside bailey.service.js's own sessionRegistry, because that is the
 * only place that actually knows when a socket gets silently replaced
 * (automatic reconnect, pairing recovery). Keeping a second copy of that
 * state here would go stale exactly at those moments and risk sending
 * messages through a dead socket. SessionManager only adds API-facing
 * concerns on top: input validation, ApiError translation, DB persistence,
 * and startup restoration.
 */
export class SessionManager {
  private static instance: SessionManager;

  /**
   * Tracks sessionIds with a pairing-code request currently in flight.
   *
   * bailey.service.js's requestPairingCodeSafely() has no guard of its own
   * against two concurrent calls for the same sessionId — nothing stops a
   * double-click or a retrying client from firing two requests to WhatsApp
   * at once for the same number. Given how sensitive WhatsApp's pairing
   * endpoint already showed itself to be to rapid repeated attempts, this
   * guard rejects the second call outright instead of letting both race.
   */
  private readonly pairingInFlight: Set<string> = new Set();

  private constructor() { }

  /**
   * Retrieves the global singleton instance of SessionManager.
   */
  public static getInstance(): SessionManager {
    if (!SessionManager.instance) {
      SessionManager.instance = new SessionManager();
    }
    return SessionManager.instance;
  }

  /**
   * Returns the CURRENT live socket for a session, read straight from
   * bailey.service.js's own registry — never a locally cached copy.
   */
  public getSession(sessionId: string): WASocket | undefined {
    return getManagedSession(sessionId)?.socket ?? undefined;
  }

  /**
   * True only when the session is actually connected right now, not merely
   * "has a socket object" (a socket can exist while still connecting,
   * reconnecting, or awaiting pairing).
   */
  public isSessionActive(sessionId: string): boolean {
    return getSessionState(sessionId) === 'CONNECTED';
  }

  /**
   * Safe getter or connection initializer. No local locking is needed here:
   * establishConnection() in bailey.service.js already guards against
   * concurrent duplicate socket creation for the same sessionId via its own
   * pendingConnections map, so every caller — SessionManager included —
   * shares that single guard instead of each layer keeping its own.
   *
   * @param sessionId - Unique session key identifier
   * @param phoneNumber - Optional E.164 formatted target telephone number
   * @returns Active {@link WASocket} instance
   */
  public async getOrCreateSession(sessionId: string, phoneNumber?: string): Promise<WASocket> {
    const existingSock = this.getSession(sessionId);

    if (existingSock) {
      logDevDebug('GET_OR_CREATE', `Existing socket retrieved for session: ${sessionId}`);
      return existingSock;
    }

    logDevDebug('GET_OR_CREATE', `Establishing new socket connection for session: ${sessionId}`);

    return establishConnection(sessionId, { phoneNumber });
  }

  /**
   * Initializes a WhatsApp socket and requests a pairing code for phone number authentication.
   *
   * @param sessionId - Unique session key identifier
   * @param phoneNumber - E.164 formatted target telephone number (e.g., "255712345678")
   * @returns Promise resolving to formatted pairing code string (e.g. "ABCD-1234")
   *
   * @throws {@link ApiError} if socket initialization or pairing request fails
   *
   * @example
   * ```typescript
   * const code = await sessionManager.requestPairingCode('tenant-101', '255712345678');
   * console.log('Pairing Code:', code);
   * ```
   */
  public async requestPairingCode(sessionId: string, phoneNumber: string): Promise<string> {
    const cleanPhone = phoneNumber.replace(/\D/g, '');

    if (!cleanPhone || cleanPhone.length < 8) {
      throw ApiError.badRequest(
        'Invalid telephone number provided for WhatsApp pairing.',
        'INVALID_PHONE_NUMBER',
      );
    }

    if (this.pairingInFlight.has(sessionId)) {
      throw new ApiError(
        StatusCodes.CONFLICT,
        `A pairing code request is already in progress for session '${sessionId}'.`,
        'PAIRING_ALREADY_IN_PROGRESS',
      );
    }

    this.pairingInFlight.add(sessionId);

    logDevDebug('PAIRING', `Requesting pairing code for session: ${sessionId}, phone: ${cleanPhone}`);

    try {
      // Ensure a socket exists. requestPairingCodeSafely() also creates one
      // itself if missing (and shares the same pendingConnections guard as
      // establishConnection), so this call is a fast no-op in the common
      // case where initiate already created it.
      await this.getOrCreateSession(sessionId, cleanPhone);

      const pairingCode = await requestPairingCodeSafely(sessionId, {
        phoneNumber: cleanPhone,
        timeoutMs: 30000,
      });

      return pairingCode;
    } catch (err) {
      logDevDebug('PAIRING_ERROR', `Failed to obtain pairing code for session: ${sessionId}`, err);

      await this.removeSession(sessionId);

      if (err instanceof ApiError) throw err;

      throw ApiError.internal(
        `Failed to request pairing code: ${err instanceof Error ? err.message : 'Unknown error'}`,
        'PAIRING_CODE_ERROR',
      );
    } finally {
      this.pairingInFlight.delete(sessionId);
    }
  }

  /**
   * Safely stops and removes a session. Delegates entirely to
   * bailey.service.js's stopConnection(), which already owns the full
   * teardown sequence (timers, socket cleanup, registry removal) — there is
   * no separate local map here to keep in sync with it.
   *
   * @param sessionId - Target session identifier
   */
  public async removeSession(sessionId: string): Promise<void> {
    logDevDebug('REMOVE', `Removing session '${sessionId}'.`);

    try {
      await stopConnection(sessionId);
    } catch (err) {
      console.warn(`⚠️ [SessionManager] Warning during cleanup of session '${sessionId}':`, err);
    }
  }

  /**
   * Dispatches a text message through an authenticated active WhatsApp session.
   *
   * @param payload - Structured {@link SendMessagePayload} containing recipient, text, and session context
   * @returns Promise resolving to sent Baileys message object
   *
   * @throws {@link ApiError} if session is inactive or message dispatch fails
   *
   * @example
   * ```typescript
   * const sentMessage = await sessionManager.sendMessage({
   *   sessionId: 'tenant-101',
   *   to: '255712345678',
   *   text: 'Habari! Hii ni jaribio la ujumbe.'
   * });
   * ```
   */
  public async sendMessage(payload: SendMessagePayload) {
    const { sessionId, to, text } = payload;

    // Read live from the service every time — never from a local cache —
    // so a message sent right after an automatic reconnect always goes
    // through the current socket, not a destroyed one.
    const sock = this.getSession(sessionId);

    if (!sock) {
      throw ApiError.notFound(
        `Session '${sessionId}' is not active or authenticated. Please establish connection first.`,
        'SESSION_INACTIVE',
      );
    }

    const parsedJid = parseJidDetails(to);

    let destinationJid = parsedJid.raw;
    if (parsedJid.type === 'USER' && parsedJid.user) {
      destinationJid = `${parsedJid.user}@s.whatsapp.net`;
    } else if (parsedJid.type === 'UNKNOWN' && /^\d+$/.test(to.replace(/\D/g, ''))) {
      destinationJid = `${to.replace(/\D/g, '')}@s.whatsapp.net`;
    }

    if (!destinationJid) {
      throw ApiError.badRequest(`Invalid recipient destination address: '${to}'`, 'INVALID_RECIPIENT_JID');
    }

    logDevDebug('SEND_MESSAGE', `Sending message via session: ${sessionId} to JID: ${destinationJid}`);

    try {
      const sentMsg = await sock.sendMessage(destinationJid, { text });

      if (sentMsg?.key.id) {
        const userJid = sock.user?.id;
        const parsedSender = parseJidDetails(userJid);
        const senderJid = parsedSender.raw || 'system';

        await prisma.message.create({
          data: {
            sessionId,
            messageId: sentMsg.key.id,
            fromJid: senderJid,
            toJid: destinationJid,
            content: text,
            fromMe: true,
          },
        });
      }

      return sentMsg;
    } catch (err) {
      logDevDebug('SEND_ERROR', `Failed to send message via session: ${sessionId}`, err);
      throw ApiError.internal(
        `Failed to send WhatsApp message: ${err instanceof Error ? err.message : 'Socket error'}`,
        'MESSAGE_SEND_FAILED',
      );
    }
  }

  /**
   * Bootstraps and restores all previously active database sessions during application startup.
   *
   * Restored sequentially (not in parallel) on purpose: each restoration
   * makes a real network call (fetchLatestBaileysVersion) inside
   * establishConnection, and firing all of them at once on a server with
   * many sessions would create a connection stampede against WhatsApp at
   * exactly the moment it's least likely to tolerate one.
   */
  public async restoreActiveSessions(): Promise<void> {
    console.log('🔄 [SessionManager] Restoring active database sessions...');

    try {
      const activeSessions = await prisma.session.findMany({
        where: { status: 'CONNECTED' },
      });

      console.log(`📋 [SessionManager] Found ${activeSessions.length} session(s) to restore.`);

      for (const session of activeSessions) {
        try {
          console.log(`🔌 [SessionManager] Auto-reconnecting session: ${session.id}`);
          await this.getOrCreateSession(session.id, session.phoneNumber ?? undefined);
        } catch (err) {
          console.error(`❌ [SessionManager] Failed to restore session ${session.id}:`, err);
        }
      }
    } catch (err) {
      console.error('💥 [SessionManager] Error restoring database sessions:', err);
    }
  }

  /**
   * Returns the current count of active sessions, read from
   * bailey.service.js's own registry.
   */
  public getActiveSessionsCount(): number {
    return getActiveSessionIds().length;
  }
}

/** Export singleton instance reference */
export const sessionManager = SessionManager.getInstance();