import type { WAMessage } from '@whiskeysockets/baileys';

/**
 * Options for contextual actions (Mentions, Quoted Replies, Forwarding).
 */
export interface BaseMessageOptions {
  /** Array of phone numbers/JIDs to tag (e.g. ['255712345678']) */
  mentions?: string[];
  /** Specific incoming WAMessage object to quote/reply to */
  quoted?: WAMessage;
  /** Mark as forwarded message */
  forwarded?: boolean;
  /** Forwarding count indicator */
  forwardingScore?: number;
}

export interface TextMessagePayload {
  type: 'text';
  recipientJid: string;
  text: string;
  options?: BaseMessageOptions;
}

export interface ImageMessagePayload {
  type: 'image';
  recipientJid: string;
  image: string | Buffer;
  caption?: string;
  options?: BaseMessageOptions;
}

export interface StickerMessagePayload {
  type: 'sticker';
  recipientJid: string;
  sticker: string | Buffer;
  options?: BaseMessageOptions;
}

/**
 * STRICT DISCIMINATED UNION: Audio na Video zimezuiliwa kikamilifu.
 */
export type OutboundMessagePayload = 
  | TextMessagePayload 
  | ImageMessagePayload 
  | StickerMessagePayload;