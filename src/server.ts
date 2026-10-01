import http from 'node:http';
import { Server as SocketIOServer } from 'socket.io';
import app from './app.js';
import { env } from './config/env.js';
import { prisma } from './config/database.js';
import { sessionManager } from './services/session.manager.js';

// --- 1. INITIALIZE HTTP & SOCKET.IO SERVERS ---
const httpServer = http.createServer(app);

export const io = new SocketIOServer(httpServer, {
  cors: {
    origin: process.env.CORS_ORIGIN || '*',
    methods: ['GET', 'POST']
  }
});

// --- 2. SOCKET.IO CONNECTION MANAGEMENT ---
io.on('connection', (socket) => {
  console.log(`🔌 [Socket.IO] Client connected: ${socket.id}`);

  // Join Room
  socket.on('join_session', (sessionId: string) => {
    if (typeof sessionId === 'string' && sessionId.trim() !== '') {
      socket.join(sessionId);
      console.log(`📌 [Socket.IO] Client ${socket.id} joined room: ${sessionId}`);
    }
  });

  // Leave Room (Ongeza hii)
  socket.on('leave_session', (sessionId: string) => {
    if (typeof sessionId === 'string' && sessionId.trim() !== '') {
      socket.leave(sessionId);
      console.log(`🚪 [Socket.IO] Client ${socket.id} left room: ${sessionId}`);
    }
  });

  socket.on('disconnect', (reason) => {
    console.log(`🔌 [Socket.IO] Client disconnected (${socket.id}): ${reason}`);
  });
});

// --- 3. BOOTSTRAP ENTERPRISE ENGINE ---
const PORT = env.PORT || 5000;

const server = httpServer.listen(PORT, async () => {
  console.log(`🚀 [Server] Enterprise Engine running on port ${PORT}`);

  try {
    // Restore WhatsApp/System active sessions upon bootstrap
    await sessionManager.restoreActiveSessions();
    console.log('✅ [Sessions] Active sessions successfully restored.');
  } catch (error) {
    console.error('❌ [Session Restore Failure]:', error);
  }
});

// --- 4. GRACEFUL SHUTDOWN & PROCESS GUARDS ---
async function gracefulShutdown(signal: string): Promise<void> {
  console.log(`\n🛑 [Shutdown] ${signal} signal received. Initiating graceful shutdown...`);

  // Closes HTTP server & stops accepting new requests
  server.close(async () => {
    console.log('🔒 [HTTP & Socket.IO] Connection pools closed.');

    try {
      await prisma.$disconnect();
      console.log('🔒 [Database] Prisma client disconnected.');
      process.exit(0);
    } catch (err) {
      console.error('❌ [Database Disconnect Error]:', err);
      process.exit(1);
    }
  });

  // Force exit if graceful shutdown exceeds threshold
  setTimeout(() => {
    console.error('⚠️ [Shutdown] Forced shutdown timed out after 10 seconds.');
    process.exit(1);
  }, 10000);
}

// System Termination Signals
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Process Safety Nets
process.on('unhandledRejection', (reason: unknown) => {
  console.error('💥 [Unhandled Rejection]:', reason);
});

process.on('uncaughtException', (error: Error) => {
  console.error('💥 [Uncaught Exception]:', error.message, error.stack);
  gracefulShutdown('UNCAUGHT_EXCEPTION');
});