import http from 'node:http';
import { Server as SocketIOServer, type Socket } from 'socket.io';
import app from './app.js';
import { env } from './config/env.js';
import { prisma } from './config/database.js';
import { sessionManager } from './services/session.manager.js';
import {
  getSessionProfile,
  getSessionState,
  shutdownAllConnections,
} from './services/bailey.service.js';
import {
  bindLogSocketServer,
  clearSessionLogs,
  getSessionLogs,
} from './services/session-log.service.js';

/* ============================================================================
 * 1. HTTP + SOCKET.IO
 * ========================================================================== */

const httpServer = http.createServer(app);

// CORS_ORIGIN can be a single origin or a comma separated list. '*' only as a dev fallback.
const allowedOrigins = (process.env.CORS_ORIGIN ?? '*')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

export const io = new SocketIOServer(httpServer, {
  path: '/socket.io',
  serveClient: false,
  allowEIO3: true, // for socket.io-client v2.x
  transports: ['websocket', 'polling'],
  // https://socket.io/docs/v4/handling-cors/
  cors: {
    origin: allowedOrigins.includes('*') ? '*' : allowedOrigins,
    methods: ['GET', 'POST'],
  },
  pingInterval: 20_000,
  pingTimeout: 20_000,
  // Clients only ever send tiny control messages (a session id).
  maxHttpBufferSize: 10_000,
});

// The log module needs the io instance to stream entries; binding here avoids a circular import.
bindLogSocketServer(io);

/* ============================================================================
 * 2. SOCKET HELPERS
 * ========================================================================== */

const SESSION_ID_PATTERN = /^[a-zA-Z0-9_-]{1,100}$/; // same rule as bailey.service
const MAX_ROOMS_PER_SOCKET = 10;

function isValidSessionId(value: unknown): value is string {
  return typeof value === 'string' && SESSION_ID_PATTERN.test(value);
}

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

/* ============================================================================
 * 3. SOCKET.IO EVENTS
 *
 *   join_session(sessionId, ack)  -> ack({ ok, state, profile, logs })
 *   leave_session(sessionId)
 *   clear_logs(sessionId, ack)    -> broadcasts 'session_logs_cleared' to the room
 *
 * The ack of join_session is the "snapshot": it gives a viewer that arrives late,
 * or reconnects, the current state plus the buffered logs, so nothing is missed.
 * ========================================================================== */

io.on('connection', (socket) => {
  console.log(`🔌 [Socket.IO] Client connected: ${socket.id}`);

  socket.on('join_session', async (sessionId: unknown, ack?: unknown) => {
    if (!isValidSessionId(sessionId)) {
      return reply(ack, { ok: false, error: 'INVALID_SESSION_ID' });
    }

    if (isRateLimited(socket, 'join', 30, 10_000)) {
      return reply(ack, { ok: false, error: 'RATE_LIMITED' });
    }

    if (!socket.rooms.has(sessionId) && joinedRooms(socket).length >= MAX_ROOMS_PER_SOCKET) {
      return reply(ack, { ok: false, error: 'TOO_MANY_ROOMS' });
    }

    await socket.join(sessionId);
    console.log(`📌 [Socket.IO] Client ${socket.id} joined room: ${sessionId}`);

    reply(ack, {
      ok: true,
      sessionId,
      state: getSessionState(sessionId),
      profile: getSessionProfile(sessionId),
      logs: getSessionLogs(sessionId),
      serverTime: new Date().toISOString(),
    });
  });

  socket.on('leave_session', async (sessionId: unknown, ack?: unknown) => {
    if (!isValidSessionId(sessionId)) {
      return reply(ack, { ok: false, error: 'INVALID_SESSION_ID' });
    }

    await socket.leave(sessionId);
    console.log(`🚪 [Socket.IO] Client ${socket.id} left room: ${sessionId}`);

    reply(ack, { ok: true });
  });

  socket.on('clear_logs', (sessionId: unknown, ack?: unknown) => {
    if (!isValidSessionId(sessionId)) {
      return reply(ack, { ok: false, error: 'INVALID_SESSION_ID' });
    }

    // Only someone who is actually watching this session may clear its logs.
    if (!socket.rooms.has(sessionId)) {
      return reply(ack, { ok: false, error: 'NOT_IN_SESSION' });
    }

    if (isRateLimited(socket, 'clear', 10, 10_000)) {
      return reply(ack, { ok: false, error: 'RATE_LIMITED' });
    }

    clearSessionLogs(sessionId, { notify: true });
    reply(ack, { ok: true });
  });

  socket.on('disconnect', (reason) => {
    console.log(`🔌 [Socket.IO] Client disconnected (${socket.id}): ${reason}`);
  });
});

/* ============================================================================
 * 4. BOOTSTRAP
 * ========================================================================== */

const PORT = env.PORT || 5000;

httpServer.listen(PORT, async () => {
  console.log(`🚀 [Server] Enterprise Engine running on port ${PORT}`);

  try {
    await sessionManager.restoreActiveSessions();
    console.log('✅ [Sessions] Active sessions successfully restored.');
  } catch (error) {
    console.error('❌ [Session Restore Failure]:', error);
  }
});

/* ============================================================================
 * 5. GRACEFUL SHUTDOWN & PROCESS GUARDS
 * ========================================================================== */

let shuttingDown = false;

async function gracefulShutdown(signal: string, exitCode = 0): Promise<void> {
  // A second signal (or an error during shutdown) must not start a second shutdown.
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`\n🛑 [Shutdown] ${signal} received. Initiating graceful shutdown...`);

  const forceExit = setTimeout(() => {
    console.error('⚠️ [Shutdown] Forced exit after 10 seconds.');
    process.exit(1);
  }, 10_000);
  forceExit.unref();

  try {
    // 1. Stop WhatsApp sockets first: this still emits STOPPED to connected viewers.
    await shutdownAllConnections();
    console.log('🔒 [WhatsApp] All sessions stopped.');

    // 2. io.close() disconnects every client AND closes the underlying HTTP server.
    await new Promise<void>((resolve) => io.close(() => resolve()));
    console.log('🔒 [HTTP & Socket.IO] Closed.');

    // 3. Database last.
    await prisma.$disconnect();
    console.log('🔒 [Database] Prisma client disconnected.');

    process.exit(exitCode);
  } catch (error) {
    console.error('❌ [Shutdown Error]:', error);
    process.exit(1);
  }
}

process.on('SIGTERM', () => void gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => void gracefulShutdown('SIGINT'));

process.on('unhandledRejection', (reason: unknown) => {
  console.error('💥 [Unhandled Rejection]:', reason);
});

process.on('uncaughtException', (error: Error) => {
  console.error('💥 [Uncaught Exception]:', error.message, error.stack);
  void gracefulShutdown('UNCAUGHT_EXCEPTION', 1);
});