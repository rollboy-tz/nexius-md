// src/routers/inbound.router.ts
import type { WASocket, WAMessage } from '@whiskeysockets/baileys';
import { MessageService } from '../services/message.service.js';

export interface ProcessedInboundContext {
    senderJid: string;
    messageType: 'text' | 'image' | 'sticker';
    textBody?: string;
    caption?: string;
    rawMessage: WAMessage;
}

export class InboundRouter {
    /**
     * Parses incoming WAMessage and extracts sanitized metadata context.
     */
    static parseMessage(msg: WAMessage): ProcessedInboundContext | null {
        if (!msg.message || msg.key.fromMe) return null;

        // Reject Audio, Voice Notes, and Video
        if (!MessageService.isSupportedInboundMessage(msg)) return null;

        const jid = msg.key.remoteJid;
        if (!jid) return null;

        const m = msg.message;

        // 1. Plain Text or Extended Text (Replies)
        if (m.conversation || m.extendedTextMessage?.text) {
            return {
                senderJid: jid,
                messageType: 'text',
                textBody: m.conversation || m.extendedTextMessage?.text || '',
                rawMessage: msg
            };
        }

        // 2. Image Message
        if (m.imageMessage) {
            return {
                senderJid: jid,
                messageType: 'image',
                caption: m.imageMessage.caption || '',
                rawMessage: msg
            };
        }

        // 3. Sticker Message
        if (m.stickerMessage) {
            return {
                senderJid: jid,
                messageType: 'sticker',
                rawMessage: msg
            };
        }

        return null;
    }

    /**
     * Central Route Dispatcher.
     */
    static async route(sock: WASocket, incomingBatch: WAMessage[]): Promise<void> {
        const validMessages = incomingBatch.filter(
            (m) => !m.key.fromMe && MessageService.isSupportedInboundMessage(m)
        );
        if (validMessages.length === 0) return;

        // Step A: Issue Bulk Blue Ticks for the unread stack
        await MessageService.markAllChatMessagesAsRead(sock, validMessages);

        // Step B: Get latest message with strict Type Guard
        const latestMsg = validMessages[validMessages.length - 1];
        if (!latestMsg) return; // Explicit type narrowing for strict null check

        const context = this.parseMessage(latestMsg);
        if (!context) return;

        // Step C: Execute matching handler
        if (context.messageType === 'text' && context.textBody) {
            if (context.textBody.startsWith('/')) {
                console.log(`🤖 [Router] Command detected: ${context.textBody}`);
                // Handle Command Pipeline
            } else {
                console.log(`💬 [Router] Standard Message / AI Prompt: ${context.textBody}`);
                // Handle AI or Keyword Pipeline
            }
        }
    }
}