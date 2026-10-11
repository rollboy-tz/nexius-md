// path: src/server.ts

import http from 'node:http';
import { Server as SocketIOServer, type Socket } from 'socket.io';
import { sql } from 'drizzle-orm';
import app from './app.js';
import { env } from './config/env.js';
import { db, dbClient } from './config/database.js';
import { redis } from './config/redis.js';
import { canAccessChannel, registerSocketAuth } from './realtime/socket-auth.js';
import { isUuid } from './services/auth-session.service.js';
import { getSessionProfile, getSessionState, shutdownAllConnections } from './services/bailey.service.js';
import { ChannelService } from './services/channel.service.js';
import { bindLogSocketServer, clearSessionLogs, getSessionLogs } from './services/session-log.service.js';

const isProduction = env.NODE_ENV === 'production';

/* ============================================================================
 * 1. HTTP + SOCKET.IO SETUP
 * ========================================================================== */

const httpServer = http.createServer(app);

// Accepts an array or a comma separated string. Matching is always on whole origins:
// substring matching would let "https://app.com.evil.io" pass for "https://app.com".
const allowedOrigins: readonly string[] = (
  Array.isArray(env.CORS_ORIGIN) ? env.CORS_ORIGIN : String(env.CORS_ORIGIN).split(',')
)
  .map((origin: string) => origin.trim())
  .filter(Boolean);

const allowAnyOrigin = allowedOrigins.includes('*');

if (isProduction && allowAnyOrigin) {
  throw new Error('CORS_ORIGIN must list explicit origins in production. "*" is only allowed in development.');
}

export const io = new SocketIOServer(httpServer, {
  path: '/socket.io',
  serveClient: false,
  transports: ['polling', 'websocket'],
  cors: {
    origin: (requestOrigin, callback) => {
      // No Origin header means a non-browser client (curl, server to server). Browsers always send one.
      if (!requestOrigin || allowAnyOrigin || allowedOrigins.includes(requestOrigin)) {
        return callback(null, true);
      }
      return callback(new Error('CORS policy error: Origin not allowed'));
    },
    methods: ['GET', 'POST'],
    credentials: true,
  },
  pingInterval: 20_000,
  pingTimeout: 20_000,
  // Clients only ever send tiny control messages (one id).
  maxHttpBufferSize: 10_000,
});

bindLogSocketServer(io);

// Handshake authentication, per-event channel authorization and cross-instance session revocation.
const closeSocketAuth = registerSocketAuth(io);

/* ============================================================================
 * 2. SOCKET HELPERS
 * ========================================================================== */

const MAX_ROOMS_PER_SOCKET = 10;

const debugLog = (message: string): void => {
  if (!isProduction) console.log(message);
};

function reply(ack: unknown, payload: Record<string, unknown>): void {
  if (typeof ack === 'function') (ack as (res: unknown) => void)(payload);
}

/** Sliding-window limiter kept on the socket itself, so it disappears with it. */
function isRateLimited(socket: Socket, action: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const hits: Record<string, number[]> = (socket.data.hits ??= {});
  const recent = (hits[action] ?? []).filter((t) => now - t < windowMs);

  recent.push(now);
  hits[action] = recent;

  return recent.length > limit;
}

function joinedRooms(socket: Socket): string[] {
  return [...socket.rooms].filter((room) => room !== socket.id);
}

/** An error inside a handler (database down, Redis down) must still answer the client, not leave it waiting. */
async function guarded(ack: unknown, work: () => Promise<void>): Promise<void> {
  try {
    await work();
  } catch (error) {
    console.error('❌ [Socket.IO] Handler failed:', error);
    reply(ack, { ok: false, error: 'INTERNAL_ERROR' });
  }
}

/* ============================================================================
 * 3. SOCKET.IO EVENTS
 *
 *   join_session(channelId, ack)  -> ack({ ok, state, profile, logs })   needs channel:read
 *   leave_session(channelId)
 *   clear_logs(channelId, ack)    -> broadcasts 'session_logs_cleared'     needs channel:manage
 *
 * The room name is the channel id (a UUID). The cheap checks (format, rate limit, room cap) run
 * before the authorization check, which touches Redis/Postgres.
 * ========================================================================== */

io.on('connection', (socket) => {
  debugLog(`🔌 [Socket.IO] Client connected: ${socket.id}`);

  socket.on('join_session', (sessionId: unknown, ack?: unknown) => {
    void guarded(ack, async () => {
      if (!isUuid(sessionId)) return reply(ack, { ok: false, error: 'INVALID_SESSION_ID' });
      if (isRateLimited(socket, 'join', 30, 10_000)) return reply(ack, { ok: false, error: 'RATE_LIMITED' });

      if (!socket.rooms.has(sessionId) && joinedRooms(socket).length >= MAX_ROOMS_PER_SOCKET) {
        return reply(ack, { ok: false, error: 'TOO_MANY_ROOMS' });
      }

      if (!(await canAccessChannel(socket, sessionId, 'channel:read'))) {
        return reply(ack, { ok: false, error: 'FORBIDDEN' });
      }

      await socket.join(sessionId);
      debugLog(`📌 [Socket.IO] ${socket.id} joined ${sessionId}`);

      reply(ack, {
        ok: true,
        sessionId,
        state: getSessionState(sessionId),
        profile: getSessionProfile(sessionId),
        logs: getSessionLogs(sessionId),
        serverTime: new Date().toISOString(),
      });
    });
  });

  socket.on('leave_session', (sessionId: unknown, ack?: unknown) => {
    void guarded(ack, async () => {
      if (!isUuid(sessionId)) return reply(ack, { ok: false, error: 'INVALID_SESSION_ID' });

      await socket.leave(sessionId);
      reply(ack, { ok: true });
    });
  });

  socket.on('clear_logs', (sessionId: unknown, ack?: unknown) => {
    void guarded(ack, async () => {
      if (!isUuid(sessionId)) return reply(ack, { ok: false, error: 'INVALID_SESSION_ID' });
      if (!socket.rooms.has(sessionId)) return reply(ack, { ok: false, error: 'NOT_IN_SESSION' });
      if (isRateLimited(socket, 'clear', 10, 10_000)) return reply(ack, { ok: false, error: 'RATE_LIMITED' });

      // Watching is not enough: clearing logs for every viewer needs the manage permission.
      if (!(await canAccessChannel(socket, sessionId, 'channel:manage'))) {
        return reply(ack, { ok: false, error: 'FORBIDDEN' });
      }

      clearSessionLogs(sessionId, { notify: true });
      reply(ack, { ok: true });
    });
  });

  socket.on('disconnect', (reason) => {
    debugLog(`🔌 [Socket.IO] Client disconnected (${socket.id}): ${reason}`);
  });
});

/* ============================================================================
 * 4. INFRASTRUCTURE HEALTH (startup)
 *
 * Redis is not optional any more: it holds the revoked-session list, the auth caches and the
 * login throttle. In production the server refuses to start without it.
 * ========================================================================== */

async function verifyInfrastructureHealth(): Promise<void> {
  console.log('🔍 [Startup] Verifying infrastructure services...');

  try {
    await db.execute(sql`SELECT 1`);
    console.log('✅ [Database] PostgreSQL connection established.');
  } catch (error) {
    console.error('❌ [Database] Unable to connect to PostgreSQL:', error);
    throw new Error('Database service is unreachable.');
  }

  try {
    await redis.ping();
    console.log('✅ [Redis] Connection verified.');
  } catch (error) {
    if (isProduction) {
      console.error('❌ [Redis] Unreachable:', error);
      throw new Error('Redis service is unreachable.');
    }
    console.warn('⚠️ [Redis] Unreachable. Continuing only because this is not production:', error);
  }
}

/* ============================================================================
 * 5. BOOTSTRAP
 * ========================================================================== */

const PORT = env.PORT || 5000;

async function restoreSessions(): Promise<void> {
  try {
    await ChannelService.restoreAll();
    console.log('✅ [Sessions] WhatsApp sessions restored.');
  } catch (error) {
    console.error('❌ [Session Restore Failure]:', error);
  }
}

async function bootstrap(): Promise<void> {
  try {
    await verifyInfrastructureHealth();

    // Before anything can connect, so even restored sessions get their status saved.
    ChannelService.startStatusSync();

    httpServer.once('error', (error) => {
      console.error('💥 [HTTP] Server error:', error);
      process.exit(1);
    });

    httpServer.listen(PORT, () => {
      console.log(`🚀 [Server] Enterprise Engine running on port ${PORT}`);
      void restoreSessions();
    });
  } catch (error) {
    console.error('💥 [Bootstrap Fatal Error]: Server failed to start:', error);
    process.exit(1); // PM2 / Docker restarts the process
  }
}

void bootstrap();

/* ============================================================================
 * 6. GRACEFUL SHUTDOWN
 *
 * Order matters:
 *   1. beginShutdown   : stop saving "STOPPED" for sessions we are about to stop on purpose,
 *                        otherwise nothing is left to restore on the next boot
 *   2. WhatsApp        : stops sessions while viewers can still be told (STOPPED event)
 *   3. Socket.IO + HTTP: disconnect clients, stop accepting requests
 *   4. Redis, database : only after nothing can use them
 * ========================================================================== */

let shuttingDown = false;

async function gracefulShutdown(signal: string, exitCode = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`\n🛑 [Shutdown] ${signal} received. Initiating graceful cleanup...`);

  const forceExit = setTimeout(() => {
    console.error('⚠️ [Shutdown] Forcefully terminating after timeout.');
    process.exit(exitCode !== 0 ? exitCode : 1);
  }, 10_000);
  forceExit.unref();

  try {
    ChannelService.beginShutdown();

    await shutdownAllConnections();
    console.log('🔒 [WhatsApp] All active sessions stopped.');

    const closed = new Promise<void>((resolve) => io.close(() => resolve()));
    httpServer.closeIdleConnections(); // keep-alive connections would otherwise hold the close open
    await closed;
    console.log('🔒 [HTTP & Socket.IO] Closed.');

    await closeSocketAuth();

    await redis.quit();
    console.log('🔒 [Redis] Connection closed.');

    await dbClient.end();
    console.log('🔒 [Database] Pool closed.');

    console.log('👋 [Shutdown Complete] Exiting safely.');
    process.exit(exitCode);
  } catch (error) {
    console.error('❌ [Shutdown Error]:', error);
    process.exit(1);
  }
}

process.on('SIGTERM', () => void gracefulShutdown('SIGTERM', 0));
process.on('SIGINT', () => void gracefulShutdown('SIGINT', 0));

process.on('unhandledRejection', (reason: unknown) => {
  console.error('💥 [Unhandled Rejection]:', reason);
});

process.on('uncaughtException', (error: Error) => {
  console.error('💥 [Fatal Uncaught Exception]:', error.message, error.stack);
  void gracefulShutdown('UNCAUGHT_EXCEPTION', 1);
});