// path: src/realtime/socket-auth.ts

import type { Server as SocketIOServer, Socket } from 'socket.io';
import { redis } from '../config/redis.js';
import type { PlatformRole } from '../db/schema.js';
import { AuthSessionService, isUuid } from '../services/auth-session.service.js';
import { ChannelService, type RealtimePermission } from '../services/channel.service.js';
import { appEvents, type SessionRevokedPayload } from '../services/session-events.js';
import { TokenService } from '../services/token.service.js';
import { ACCESS_COOKIE, isAllowedOrigin } from '../utils/auth-cookies.js';

/* ============================================================================
 * Types
 * ========================================================================== */

/** What the handshake proved about this connection. Stored on socket.data.user. */
export interface SocketUser {
  userId: string;
  sessionId: string;
  platformRole: PlatformRole;
}

const REVOCATION_CHANNEL = 'auth:session-revoked';

/** A connection is recycled periodically so a long-lived socket cannot outlive its credentials. */
const SOCKET_MAX_AGE_MS = 60 * 60 * 1000;
const SOCKET_MAX_AGE_JITTER_MS = 5 * 60 * 1000;
const MAX_TOKEN_LENGTH = 4096;

const UNAUTHORIZED = 'UNAUTHORIZED';

function isSocketUser(value: unknown): value is SocketUser {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<Record<keyof SocketUser, unknown>>;
  return (
    typeof candidate.userId === 'string' &&
    typeof candidate.sessionId === 'string' &&
    typeof candidate.platformRole === 'string'
  );
}

export function getSocketUser(socket: Socket): SocketUser | null {
  const value: unknown = socket.data.user;
  return isSocketUser(value) ? value : null;
}

function parseRevocation(message: string): SessionRevokedPayload | null {
  try {
    const value: unknown = JSON.parse(message);
    if (typeof value !== 'object' || value === null) return null;

    const { sessionId, userId } = value as Partial<Record<keyof SessionRevokedPayload, unknown>>;
    return typeof sessionId === 'string' && typeof userId === 'string' ? { sessionId, userId } : null;
  } catch {
    return null;
  }
}

function cookieValue(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return undefined;
}

/**  
 * ============================================================================
 * Registration
 *
 * 1. Handshake: the access token is verified with the SAME function the HTTP middleware uses
 *    (signature, expiry, revocation, account status). No token, no connection.
 * 2. Every sensitive event re-checks the session and the user's right to that channel
 *    (canAccessChannel), so revoking access takes effect on an already open socket.
 * 3. Revocation: when any API instance revokes a session it is published on Redis; every
 *    instance disconnects the matching local sockets. Works across multiple servers.
 *
 * Returns a cleanup function for the graceful shutdown.
 * ========================================================================== */

export function registerSocketAuth(io: SocketIOServer): () => Promise<void> {

  io.use(async (socket, next) => {
    try {
      const auth: unknown = socket.handshake.auth;
      const fromAuth = typeof auth === 'object' && auth !== null ? (auth as { token?: unknown }).token : undefined;
      let token = typeof fromAuth === 'string' && fromAuth.length > 0 ? fromAuth : undefined; // mobile: header ya token

      if (!token) {
        // Browser: cookie ya HttpOnly. Tovuti yoyote inaweza kuanzisha handshake yenye cookie yako,
        // kwa hiyo asili LAZIMA ithibitishwe (Cross-Site WebSocket Hijacking).
        if (!isAllowedOrigin(socket.handshake.headers.origin)) return next(new Error(UNAUTHORIZED));
        token = cookieValue(socket.handshake.headers.cookie, ACCESS_COOKIE);
      }

      if (!token || token.length > MAX_TOKEN_LENGTH) return next(new Error(UNAUTHORIZED));

      const user = await AuthSessionService.resolveAccessToken(token);
      socket.data.user = { userId: user.userId, sessionId: user.sessionId, platformRole: user.platformRole } satisfies SocketUser;
      next();
    } catch {
      next(new Error(UNAUTHORIZED));
    }
  });

  io.on('connection', (socket) => {
    const user = getSocketUser(socket);
    if (!user) {
      socket.disconnect(true);
      return;
    }

    // Names contain ':' which join_session's id pattern rejects, so clients can never join these rooms.
    void socket.join([`sid:${user.sessionId}`, `uid:${user.userId}`]);

    const recycle = setTimeout(
      () => socket.disconnect(true),
      SOCKET_MAX_AGE_MS + Math.floor(Math.random() * SOCKET_MAX_AGE_JITTER_MS),
    );
    recycle.unref();
    socket.on('disconnect', () => clearTimeout(recycle));
  });

  /* ---- revocation: local event -> Redis -> every instance ---- */

  const subscriber = redis.duplicate();

  subscriber.on('error', (error) => console.error('❌ [SocketAuth] Redis subscriber error:', error.message));
  subscriber.on('message', (channel, message) => {
    if (channel !== REVOCATION_CHANNEL) return;

    const revoked = parseRevocation(message);
    if (revoked) io.in(`sid:${revoked.sessionId}`).disconnectSockets(true);
  });
  void subscriber.subscribe(REVOCATION_CHANNEL).catch((error: unknown) => {
    console.error('❌ [SocketAuth] Could not subscribe to revocations:', error);
  });

  appEvents.onSessionRevoked((payload) => {
    void redis.publish(REVOCATION_CHANNEL, JSON.stringify(payload)).catch((error: unknown) => {
      console.error('❌ [SocketAuth] Could not publish revocation:', error);
    });
  });

  return async () => {
    try {
      await subscriber.quit();
    } catch {
      subscriber.disconnect();
    }
  };
}

/* ============================================================================
 * Authorization for room events (join_session, clear_logs)
 * ========================================================================== */

export async function canAccessChannel(
  socket: Socket,
  channelId: unknown,
  permission: RealtimePermission,
): Promise<boolean> {
  const user = getSocketUser(socket);
  if (!user || !isUuid(channelId)) return false;

  if (await TokenService.isSessionDenied(user.sessionId)) return false;

  // Fresh role and status, not whatever was true at handshake time.
  const context = await AuthSessionService.getUserContext(user.userId);
  if (!context) return false;

  return ChannelService.authorizeRealtimeAccess(
    { userId: context.userId, platformRole: context.platformRole },
    channelId,
    permission,
  );
}