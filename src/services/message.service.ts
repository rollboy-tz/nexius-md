import type {
  WASocket,
  AnyMessageContent,
  MiscMessageGenerationOptions,
  proto,
  WAMessage
} from '@whiskeysockets/baileys';
import { HumanizerService } from './humanizer.service.js';
import type {
  TextMessagePayload,
  ImageMessagePayload,
  StickerMessagePayload,
  BaseMessageOptions,
  OutboundMessagePayload
} from '../types/message.types.js';
import { ApiError } from '../utils/api.error.js';

/**
 * Enterprise-Grade Message Dispatcher Service.
 * 
 * Enforces strict human behavior simulation (anti-ban protocols), dynamic typing delay,
 * unsupported media guarding, and Protobuf v7 type safety for outbound and inbound WhatsApp traffic.
 * 
 * @category Services
 */
export class MessageService {
  /**
   * Normalizes raw phone numbers or group IDs into standard, fully-qualified WhatsApp JIDs.
   * 
   * @param {string} target - Raw phone number (e.g., '255712345678'), JID, or Group JID.
   * @returns {string} Fully qualified WhatsApp JID formatted as `number@s.whatsapp.net` or `group@g.us`.
   * 
   * @example
   * ```typescript
   * const userJid = MessageService.formatJid('255712345678'); // '255712345678@s.whatsapp.net'
   * const groupJid = MessageService.formatJid('120363023847@g.us'); // '120363023847@g.us'
   * ```
   */
  public static formatJid(target: string): string {
    const cleanTarget = target.trim();
    if (cleanTarget.endsWith('@g.us') || cleanTarget.endsWith('@s.whatsapp.net')) {
      return cleanTarget;
    }
    const digitsOnly = cleanTarget.replace(/\D/g, '');
    return `${digitsOnly}@s.whatsapp.net`;
  }

  /**
   * Enterprise Media Guard: Inspects inbound message payloads and filters out unsupported media types.
   * Rejects voice notes, audio files, and instant video notes (PTV) to shield processing pipelines.
   *
   * @param {WAMessage} message - Raw inbound Baileys message object.
   * @returns {boolean} `true` if the message is supported (Text, Image, Sticker); `false` if rejected.
   * 
   * @example
   * ```typescript
   * if (!MessageService.isSupportedInboundMessage(incomingMsg)) {
   *   return; // Skip unsupported media execution
   * }
   * ```
   */
  public static isSupportedInboundMessage(message: WAMessage): boolean {
    const msgContent = message.message;
    if (!msgContent) return false;

    // Block Audio, Voice Notes, and Push-To-Talk Video Notes (PTV)
    if (
      msgContent.audioMessage ||
      msgContent.videoMessage ||
      msgContent.ptvMessage
    ) {
      console.warn(
        `🛑 [MediaGuard] Blocked unsupported media type (Audio/Video/PTV) from JID: ${message.key.remoteJid ?? 'Unknown'}`
      );
      return false;
    }

    return true;
  }

  /**
   * Issues bulk read receipts (Blue Ticks) for unread chat messages.
   * Engineered with strict filtering to conform with `exactOptionalPropertyTypes` and Baileys `proto.IMessageKey`.
   *
   * @param {WASocket} sock - Active, authenticated Baileys socket instance.
   * @param {WAMessage[]} unreadMessages - Array of incoming unread `WAMessage` objects.
   * @returns {Promise<void>} Resolves once read receipts are dispatched to WhatsApp servers.
   */
  public static async markAllChatMessagesAsRead(
    sock: WASocket,
    unreadMessages: WAMessage[]
  ): Promise<void> {
    try {
      if (!unreadMessages || unreadMessages.length === 0) return;

      // Filter non-null message keys sent by external participants
      const keys: proto.IMessageKey[] = unreadMessages
        .filter((msg): msg is WAMessage & { key: { id: string } } => {
          return !msg.key.fromMe && Boolean(msg.key.id);
        })
        .map((msg) => {
          const key: proto.IMessageKey = {
            remoteJid: msg.key.remoteJid ?? null,
            id: msg.key.id,
            fromMe: false
          };

          if (msg.key.participant) {
            key.participant = msg.key.participant;
          }

          return key;
        });

      if (keys.length > 0) {
        await sock.readMessages(keys);
      }
    } catch (error) {
      console.warn(`⚠️ [MessageService] Bulk read receipt operation encountered a non-fatal warning:`, error);
    }
  }

  /**
   * Builds context metadata (mentions, quoted messages, forward status) matching Protobuf specifications.
   *
   * @param {BaseMessageOptions} [options] - Base message configuration containing metadata.
   * @returns {proto.IContextInfo | null} Configured `IContextInfo` object or `null` if no options applied.
   * @private
   */
  private static buildContextInfo(options?: BaseMessageOptions): proto.IContextInfo | null {
    if (!options) return null;

    const contextInfo: proto.IContextInfo = {};
    let hasKeys = false;

    if (options.mentions && options.mentions.length > 0) {
      contextInfo.mentionedJid = options.mentions.map((m) => this.formatJid(m));
      hasKeys = true;
    }

    if (options.forwarded) {
      contextInfo.isForwarded = true;
      contextInfo.forwardingScore = options.forwardingScore || 1;
      hasKeys = true;
    }

    return hasKeys ? contextInfo : null;
  }

  /**
   * Primary Outbound Router: Dispatches structured message payloads to destination targets.
   *
   * @param {WASocket} sock - Active, authenticated Baileys socket instance.
   * @param {OutboundMessagePayload} payload - Polymorphic message payload (Text, Image, or Sticker).
   * @returns {Promise<proto.IWebMessageInfo | undefined>} Dispatched Protobuf message metadata.
   * @throws {ApiError} If payload type is unsupported or validation fails.
   * 
   * @example
   * ```typescript
   * const response = await MessageService.sendMessage(sock, {
   *   type: 'text',
   *   recipientJid: '255712345678',
   *   text: 'Habari! Mfumo uko tayari.'
   * });
   * ```
   */
  public static async sendMessage(
    sock: WASocket,
    payload: OutboundMessagePayload
  ): Promise<proto.IWebMessageInfo | undefined> {
    switch (payload.type) {
      case 'text':
        return this.sendTextMessage(sock, payload);
      case 'image':
        return this.sendImageMessage(sock, payload);
      case 'sticker':
        return this.sendStickerMessage(sock, payload);
      default: {
        const _exhaustiveCheck: never = payload;
        throw ApiError.badRequest('Unsupported outbound message type', 'INVALID_MESSAGE_TYPE');
      }
    }
  }

  /**
   * Dispatches outbound plain-text messages with dynamic reading pauses and human typing simulations.
   *
   * @param {WASocket} sock - Active, authenticated Baileys socket instance.
   * @param {TextMessagePayload} payload - Plain text message payload structure.
   * @returns {Promise<proto.IWebMessageInfo | undefined>} Dispatched Protobuf message metadata.
   * @throws {ApiError} If text content is empty or dispatch fails.
   */
  public static async sendTextMessage(
    sock: WASocket,
    payload: TextMessagePayload
  ): Promise<proto.IWebMessageInfo | undefined> {
    const jid = this.formatJid(payload.recipientJid);

    if (!payload.text || payload.text.trim() === '') {
      throw ApiError.badRequest('Text content cannot be empty', 'EMPTY_TEXT');
    }

    try {
      // 1. Human Pause: Simulate initial reading delay (1.0s - 2.5s)
      const readPause = HumanizerService.getRandomDelay(1000, 2500);
      await new Promise((resolve) => setTimeout(resolve, readPause));

      // 2. Simulate human typing indicator on WhatsApp client
      await HumanizerService.simulateHumanTyping(sock, jid, payload.text);

      // 3. Construct Protobuf payload
      const contextInfo = this.buildContextInfo(payload.options);
      const messageContent: AnyMessageContent = {
        text: payload.text,
        ...(contextInfo && { contextInfo })
      };

      const dispatchOptions: MiscMessageGenerationOptions = {};
      if (payload.options?.quoted) {
        dispatchOptions.quoted = payload.options.quoted;
      }

      // 4. Dispatch via Baileys Socket Engine
      const result = await sock.sendMessage(jid, messageContent, dispatchOptions);
      return result ?? undefined;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      console.error(`❌ [MessageService] Outbound Text Dispatch Error to ${jid}:`, error);
      throw ApiError.internal('Failed to dispatch outbound text message', 'TEXT_DISPATCH_FAILED');
    }
  }

  /**
   * Dispatches outbound image messages with captions and human delay patterns.
   *
   * @param {WASocket} sock - Active, authenticated Baileys socket instance.
   * @param {ImageMessagePayload} payload - Image message payload structure.
   * @returns {Promise<proto.IWebMessageInfo | undefined>} Dispatched Protobuf message metadata.
   * @throws {ApiError} If image URL or buffer is missing.
   */
  public static async sendImageMessage(
    sock: WASocket,
    payload: ImageMessagePayload
  ): Promise<proto.IWebMessageInfo | undefined> {
    const jid = this.formatJid(payload.recipientJid);

    if (!payload.image) {
      throw ApiError.badRequest('Image source URL or Buffer is required', 'MISSING_IMAGE');
    }

    try {
      const readPause = HumanizerService.getRandomDelay(1000, 2500);
      await new Promise((resolve) => setTimeout(resolve, readPause));

      await HumanizerService.simulateHumanTyping(sock, jid, payload.caption || 'image');

      const contextInfo = this.buildContextInfo(payload.options);
      const imageSource = typeof payload.image === 'string' ? { url: payload.image } : payload.image;

      const messageContent: AnyMessageContent = {
        image: imageSource,
        caption: payload.caption || '',
        ...(contextInfo && { contextInfo })
      };

      const dispatchOptions: MiscMessageGenerationOptions = {};
      if (payload.options?.quoted) {
        dispatchOptions.quoted = payload.options.quoted;
      }

      const result = await sock.sendMessage(jid, messageContent, dispatchOptions);
      return result ?? undefined;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      console.error(`❌ [MessageService] Outbound Image Dispatch Error to ${jid}:`, error);
      throw ApiError.internal('Failed to dispatch outbound image message', 'IMAGE_DISPATCH_FAILED');
    }
  }

  /**
   * Dispatches outbound WhatsApp Sticker messages.
   *
   * @param {WASocket} sock - Active, authenticated Baileys socket instance.
   * @param {StickerMessagePayload} payload - Sticker message payload structure.
   * @returns {Promise<proto.IWebMessageInfo | undefined>} Dispatched Protobuf message metadata.
   * @throws {ApiError} If sticker URL or buffer is missing.
   */
  public static async sendStickerMessage(
    sock: WASocket,
    payload: StickerMessagePayload
  ): Promise<proto.IWebMessageInfo | undefined> {
    const jid = this.formatJid(payload.recipientJid);

    if (!payload.sticker) {
      throw ApiError.badRequest('Sticker source URL or Buffer is required', 'MISSING_STICKER');
    }

    try {
      const readPause = HumanizerService.getRandomDelay(800, 1800);
      await new Promise((resolve) => setTimeout(resolve, readPause));

      const contextInfo = this.buildContextInfo(payload.options);
      const stickerSource = typeof payload.sticker === 'string' ? { url: payload.sticker } : payload.sticker;

      const messageContent: AnyMessageContent = {
        sticker: stickerSource,
        ...(contextInfo && { contextInfo })
      };

      const dispatchOptions: MiscMessageGenerationOptions = {};
      if (payload.options?.quoted) {
        dispatchOptions.quoted = payload.options.quoted;
      }

      const result = await sock.sendMessage(jid, messageContent, dispatchOptions);
      return result ?? undefined;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      console.error(`❌ [MessageService] Outbound Sticker Dispatch Error to ${jid}:`, error);
      throw ApiError.internal('Failed to dispatch outbound sticker message', 'STICKER_DISPATCH_FAILED');
    }
  }
}