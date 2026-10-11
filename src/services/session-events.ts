import { EventEmitter } from 'node:events';

/**
 * Small in-process event bus. It exists to break import cycles:
 *   bailey.service    -> emits channel status, knows nothing about the database
 *   channel.service   -> listens and persists it
 *   token.service     -> emits revocations, knows nothing about Socket.IO
 *   socket-auth       -> listens and disconnects the matching sockets
 *
 * It is per process. Each WhatsApp session lives in exactly one process, so status events are
 * handled where they happen. For revocation across several API instances, use the Socket.IO
 * Redis adapter (see README).
 */

export interface ChannelStatusPayload {
  state: string;
  message?: string | undefined;
  phoneNumber?: string | null | undefined;
  profile?: { jid: string | null; name: string | null; phoneNumber: string | null; lid: string | null } | null | undefined;
}

export interface SessionRevokedPayload {
  sessionId: string;
  userId: string;
}

const bus = new EventEmitter();
bus.setMaxListeners(20);

export const appEvents = {
  emitChannelStatus(channelId: string, payload: ChannelStatusPayload): void {
    bus.emit('channel.status', channelId, payload);
  },

  onChannelStatus(listener: (channelId: string, payload: ChannelStatusPayload) => void): void {
    bus.on('channel.status', listener);
  },

  emitSessionRevoked(payload: SessionRevokedPayload): void {
    bus.emit('auth.session_revoked', payload);
  },

  onSessionRevoked(listener: (payload: SessionRevokedPayload) => void): void {
    bus.on('auth.session_revoked', listener);
  },
};