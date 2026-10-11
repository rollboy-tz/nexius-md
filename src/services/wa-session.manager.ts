// path: src/services/wa-session.manager.ts

import type { WASocket } from '@whiskeysockets/baileys';
import { db } from '../config/database.js';
import { env } from '../config/env.js';
import { StatusCodes } from '../constants/status-codes.js';
import { channelMessages } from '../db/schema.js';
import { ApiError } from '../utils/api.error.js';
import {
  establishConnection,
  getActiveSessionIds,
  getSession as getManagedSession,
  getSessionProfile,
  getSessionState,
  parseJidDetails,
  requestPairingCodeSafely,
  stopConnection,
  type SessionLifecycleState,
  type SessionUserProfile,
} from './bailey.service.js';

/* ============================================================================
 * Types
 * ========================================================================== */

export interface SendMessagePayload {
  /** Owner of the channel. Stored with the message so tenant queries need no join. */
  organizationId: string;
  /** The channel id (it is also the Baileys session id). */
  sessionId: string;
  /** A phone number (digits), a user JID, a group JID or a LID. */
  to: string;
  text: string;
}

/** What callers get back. Baileys' raw message object is deliberately not exposed. */
export interface SentMessage {
  messageId: string;
  /** The normalised JID the message was addressed to. */
  to: string;
  sentAt: string;
}

export interface SessionStatus {
  sessionId: string;
  state: SessionLifecycleState | null;
  connected: boolean;
  profile: SessionUserProfile | null;
}

/* ============================================================================
 * Constants & helpers
 * ========================================================================== */

const PAIRING_TIMEOUT_MS = 30_000;
const MAX_TEXT_LENGTH = 4_096;
const PHONE_RE = /^\d{8,15}$/;

const isDevelopment = env.NODE_ENV === 'development';

function debug(tag: string, message: string): void {
  if (isDevelopment) console.log(`\x1b[35m[WA-MGR:${tag}]\x1b[0m ${message}`);
}

const conflict = (message: string, code: string): ApiError => new ApiError(StatusCodes.CONFLICT, message, code);

/** Digits only, 8 to 15 long, or null. */
export function normalizePhoneNumber(value: string): string | null {
  const digits = value.replace(/\D/g, '');
  return PHONE_RE.test(digits) ? digits : null;
}

/** Turns what a caller typed into a JID WhatsApp accepts, or rejects it. Never guesses. */
function resolveRecipient(to: string): string {
  const raw = to.trim();
  const parsed = parseJidDetails(raw);

  if (parsed.type === 'GROUP' || parsed.type === 'LID') return parsed.raw;

  if (parsed.type === 'USER' || parsed.type === 'UNKNOWN') {
    // "2557...:12@s.whatsapp.net" carries a device suffix after ':', which is not part of the number.
    const base = (parsed.user ?? raw).split(':')[0] ?? '';
    const phone = normalizePhoneNumber(base);
    if (phone) return `${phone}@s.whatsapp.net`;
  }

  throw ApiError.badRequest('Invalid recipient. Use a phone number with country code, or a group id.', 'INVALID_RECIPIENT');
}

/* ============================================================================
 * WASessionManager
 *
 * Deliberately thin. It holds NO socket state: the single source of truth for "which socket is
 * live for a session" is bailey.service's registry, because only that code knows when a socket is
 * silently replaced (reconnect, pairing recovery). This class adds the API-facing parts:
 * validation, error translation, "is it really connected" checks, and message persistence.
 *
 * It does not know about organizations or permissions. Callers (controllers) authorise first,
 * with ChannelService.get(organizationId, channelId).
 *
 * Boot-time restore lives in ChannelService.restoreAll(), which keeps this file free of any
 * dependency on ChannelService (the other direction already exists).
 * ========================================================================== */

export class WASessionManager {
  /** Pairing requests currently in flight. A double click must not fire two requests at WhatsApp. */
  private readonly pairingInFlight = new Set<string>();

  /* ------------------------------- inspection ------------------------------- */

  /** The CURRENT socket, read live every time. Never cache it: it can be replaced at any moment. */
  public getSocket(sessionId: string): WASocket | undefined {
    return getManagedSession(sessionId)?.socket ?? undefined;
  }

  public getState(sessionId: string): SessionLifecycleState | null {
    return getSessionState(sessionId);
  }

  /** True only when actually online. A socket object can exist while connecting or awaiting pairing. */
  public isConnected(sessionId: string): boolean {
    return getSessionState(sessionId) === 'CONNECTED';
  }

  public getStatus(sessionId: string): SessionStatus {
    const state = getSessionState(sessionId);
    return {
      sessionId,
      state,
      connected: state === 'CONNECTED',
      profile: getSessionProfile(sessionId),
    };
  }

  public getActiveSessionsCount(): number {
    return getActiveSessionIds().length;
  }

  /* -------------------------------- lifecycle -------------------------------- */

  /**
   * Returns the live socket, or starts a connection. Safe to call concurrently:
   * establishConnection() already de-duplicates simultaneous starts per session.
   */
  public async getOrCreateSession(sessionId: string, phoneNumber?: string): Promise<WASocket> {
    const existing = this.getSocket(sessionId);
    if (existing) {
      debug('START', `reusing live socket for ${sessionId}`);
      return existing;
    }

    const phone = phoneNumber ? normalizePhoneNumber(phoneNumber) : null;
    if (phoneNumber && !phone) {
      throw ApiError.badRequest('Invalid phone number. Use digits with country code, without "+".', 'INVALID_PHONE_NUMBER');
    }

    debug('START', `connecting ${sessionId}`);
    return establishConnection(sessionId, { phoneNumber: phone });
  }

  /**
   * Starts the session if needed and returns a pairing code. On any failure the half-open session is
   * torn down, so the next attempt starts clean.
   */
  public async requestPairingCode(sessionId: string, phoneNumber: string): Promise<string> {
    const phone = normalizePhoneNumber(phoneNumber);
    if (!phone) {
      throw ApiError.badRequest('Invalid phone number. Use digits with country code, without "+".', 'INVALID_PHONE_NUMBER');
    }

    if (this.isConnected(sessionId)) {
      throw conflict('This WhatsApp account is already connected.', 'ALREADY_CONNECTED');
    }
    if (this.pairingInFlight.has(sessionId)) {
      throw conflict('A pairing request is already in progress for this session.', 'PAIRING_ALREADY_IN_PROGRESS');
    }

    this.pairingInFlight.add(sessionId);

    try {
      await this.getOrCreateSession(sessionId, phone);
      return await requestPairingCodeSafely(sessionId, { phoneNumber: phone, timeoutMs: PAIRING_TIMEOUT_MS });
    } catch (error) {
      console.error(`❌ [WA-MGR] Pairing failed for ${sessionId}:`, error instanceof Error ? error.message : error);
      await this.removeSession(sessionId);

      if (error instanceof ApiError) throw error;
      // The technical reason is in the session's live log stream; the client gets a safe message.
      throw ApiError.internal('WhatsApp did not return a pairing code in time. Please try again.', 'PAIRING_CODE_ERROR');
    } finally {
      this.pairingInFlight.delete(sessionId);
    }
  }

  /** Stops the connection and releases its resources. Stored credentials are kept, so it can be started again. */
  public async removeSession(sessionId: string): Promise<void> {
    debug('STOP', sessionId);

    try {
      await stopConnection(sessionId);
    } catch (error) {
      console.warn(`⚠️ [WA-MGR] Cleanup warning for ${sessionId}:`, error instanceof Error ? error.message : error);
    }
  }

  /* -------------------------------- messaging -------------------------------- */

  public async sendMessage(payload: SendMessagePayload): Promise<SentMessage> {
    const { organizationId, sessionId } = payload;

    const text = payload.text.trim();
    if (text.length === 0 || text.length > MAX_TEXT_LENGTH) {
      throw ApiError.badRequest(`Message text must be between 1 and ${MAX_TEXT_LENGTH} characters.`, 'INVALID_MESSAGE_TEXT');
    }

    const to = resolveRecipient(payload.to);

    // Read live: a message sent right after an automatic reconnect must use the NEW socket.
    const socket = this.getSocket(sessionId);
    if (!socket || !this.isConnected(sessionId)) {
      throw conflict('The WhatsApp account is not connected. Connect it first.', 'SESSION_NOT_CONNECTED');
    }

    let messageId: string | null | undefined;
    try {
      const sent = await socket.sendMessage(to, { text });
      messageId = sent?.key.id;
    } catch (error) {
      console.error(`❌ [WA-MGR] Send failed on ${sessionId}:`, error instanceof Error ? error.message : error);
      throw ApiError.internal('The message could not be sent. Please try again.', 'MESSAGE_SEND_FAILED');
    }

    if (!messageId) {
      throw ApiError.internal('WhatsApp did not confirm the message.', 'MESSAGE_SEND_FAILED');
    }

    // The message IS sent at this point. Failing to log it must never report the send as failed,
    // or a client retry would deliver it twice.
    try {
      await db
        .insert(channelMessages)
        .values({
          organizationId,
          channelId: sessionId,
          externalMessageId: messageId,
          direction: 'OUTBOUND',
          fromAddress: parseJidDetails(socket.user?.id).raw || sessionId,
          toAddress: to,
          content: text,
        })
        .onConflictDoNothing();
    } catch (error) {
      console.error(`⚠️ [WA-MGR] Message ${messageId} was sent but could not be stored:`, error);
    }

    return { messageId, to, sentAt: new Date().toISOString() };
  }
}

export const waSessionManager = new WASessionManager();