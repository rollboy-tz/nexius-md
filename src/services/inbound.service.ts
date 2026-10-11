// path: src/services/inbound.service.ts

import { normalizeMessageContent, type WAMessage, type WASocket, type proto } from '@whiskeysockets/baileys';
import { eq } from 'drizzle-orm';
import { db } from '../config/database.js';
import { channelMessages, channelOptOuts, channels, type MessageKind } from '../db/schema.js';
import { enqueueMarkRead, enqueueStatusView } from '../queue/outbound.queue.js';
import type { MessageMedia, ParsedMessage } from '../types/message.types.js';
import { isGroupJid, STATUS_JID } from '../utils/jid.util.js';
import { prepareText } from '../utils/whatsapp-format.js';
import { AutomationService } from './automation.service.js';
import { HumanizerService } from './humanizer.service.js';
import { MessageService } from './message.service.js';

/**
 * Everything that arrives on a connected number.
 *
 * In scope (this version): text (with its WhatsApp formatting), images, stickers, and other people's
 * statuses. Out of scope: video, voice notes, round video notes. Those are dropped before anything
 * is read or stored.
 *
 * Wire it up in bailey.service.ts, right after the socket is created:
 *     attachInboundHandlers(sock, session.sessionId);
 */

/** A whole message that only says one of these means "stop writing to me". Exact match: no false alarms mid-sentence. */
const OPT_OUT = /^\s*(stop|unsubscribe|cancel|acha|simamisha|sitaki)[\s.!]*$/i;

const MAX_STORED_TEXT = 20_000;
const CHANNEL_CACHE_MS = 5 * 60_000;

const channelCache = new Map<string, { organizationId: string; ownAddress: string | null; expiresAt: number }>();

async function channelInfo(channelId: string): Promise<{ organizationId: string; ownAddress: string | null } | null> {
  const cached = channelCache.get(channelId);
  if (cached && cached.expiresAt > Date.now()) return cached;

  const [row] = await db
    .select({ organizationId: channels.organizationId, ownAddress: channels.externalId })
    .from(channels)
    .where(eq(channels.id, channelId))
    .limit(1);
  if (!row) return null;

  channelCache.set(channelId, { ...row, expiresAt: Date.now() + CHANNEL_CACHE_MS });
  return row;
}

/* ============================================================================
 * Small converters
 * ========================================================================== */

/** Baileys hands numbers over as number, bigint or protobuf Long. */
function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'object' && value !== null && 'toNumber' in value) {
    return (value as { toNumber: () => number }).toNumber();
  }
  return null;
}

/** "2557...:12@s.whatsapp.net" -> "2557...@s.whatsapp.net" */
function withoutDevice(jid: string): string {
  const [user = '', server = ''] = jid.split('@');
  return `${user.split(':')[0] ?? user}@${server}`;
}

/**
 * Newer WhatsApp versions may identify a person by an opaque id (@lid). When the phone-number
 * form is also provided we prefer it: it is what we store, match and reply to.
 */
function peerOf(key: proto.IMessageKey): string {
  const chat = key.remoteJid ?? '';
  const alternative = (key as { remoteJidAlt?: string | null }).remoteJidAlt;
  return chat.endsWith('@lid') && alternative?.endsWith('@s.whatsapp.net') ? alternative : chat;
}

function cleanText(raw: string | null | undefined): ParsedMessage | null {
  if (!raw) return null;
  try {
    return prepareText(raw.length > MAX_STORED_TEXT ? raw.slice(0, MAX_STORED_TEXT) : raw, MAX_STORED_TEXT);
  } catch {
    return null; // empty after cleaning: nothing worth keeping
  }
}

interface Extracted {
  kind: Extract<MessageKind, 'TEXT' | 'IMAGE' | 'STICKER'>;
  text: ParsedMessage | null;
  media: MessageMedia | null;
  mentionedJids: string[];
}

/** Returns null for everything we do not handle in this version (reactions, polls, documents, locations...). */
function extract(content: proto.IMessage): Extracted | null {
  if (content.conversation) {
    return { kind: 'TEXT', text: cleanText(content.conversation), media: null, mentionedJids: [] };
  }

  if (content.extendedTextMessage?.text) {
    return {
      kind: 'TEXT',
      text: cleanText(content.extendedTextMessage.text),
      media: null,
      mentionedJids: content.extendedTextMessage.contextInfo?.mentionedJid ?? [],
    };
  }

  if (content.imageMessage) {
    const image = content.imageMessage;
    const caption = cleanText(image.caption);

    return {
      kind: 'IMAGE',
      text: caption,
      mentionedJids: image.contextInfo?.mentionedJid ?? [],
      media: {
        type: 'image',
        mimetype: image.mimetype ?? null,
        sizeBytes: toNumber(image.fileLength),
        width: image.width ?? null,
        height: image.height ?? null,
        sha256: image.fileSha256 ? Buffer.from(image.fileSha256).toString('hex') : null,
        caption: caption?.text ?? null,
        sourceUrl: null,
        storageKey: null, // the picture itself is not stored in this version, only what describes it
      },
    };
  }

  if (content.stickerMessage) {
    const sticker = content.stickerMessage;

    return {
      kind: 'STICKER',
      text: null,
      mentionedJids: [],
      media: {
        type: 'sticker',
        mimetype: sticker.mimetype ?? null,
        sizeBytes: toNumber(sticker.fileLength),
        width: sticker.width ?? null,
        height: sticker.height ?? null,
        sha256: sticker.fileSha256 ? Buffer.from(sticker.fileSha256).toString('hex') : null,
        caption: null,
        sourceUrl: null,
        storageKey: null,
      },
    };
  }

  return null;
}

/* ============================================================================
 * Handlers
 * ========================================================================== */

async function handleStatus(channelId: string, message: WAMessage): Promise<void> {
  const poster = message.key.participant;
  const statusId = message.key.id;
  if (!poster || !statusId || !message.message) return;

  const content = normalizeMessageContent(message.message);
  if (!content || content.videoMessage || content.audioMessage || content.ptvMessage) return;

  const policy = await AutomationService.getStatusViewPolicy(channelId);
  if (!policy) return;

  // Look at SOME statuses, SOME time later. Each decision and each delay is random.
  if (!HumanizerService.shouldAct(policy.viewProbability)) return;

  await enqueueStatusView(
    channelId,
    poster,
    statusId,
    HumanizerService.statusViewDelayMs(policy.minDelayMinutes, policy.maxDelayMinutes),
  );
}

async function handleMessage(sock: WASocket, channelId: string, message: WAMessage): Promise<void> {
  const chatJid = message.key.remoteJid;
  if (!chatJid || message.key.fromMe || !message.message) return;

  if (chatJid === STATUS_JID) return handleStatus(channelId, message);

  // Video, voice notes and round video notes are never touched in this version.
  if (!MessageService.isSupportedInboundMessage(message)) return;

  const externalMessageId = message.key.id;
  const content = normalizeMessageContent(message.message); // unwraps disappearing and view-once wrappers
  if (!externalMessageId || !content) return;

  const extracted = extract(content);
  if (!extracted) return;

  const info = await channelInfo(channelId);
  if (!info) return;

  const group = isGroupJid(chatJid);
  const peer = group ? (message.key.participant ?? chatJid) : peerOf(message.key);
  const ownAddress = info.ownAddress ?? (sock.user?.id ? withoutDevice(sock.user.id) : 'self');

  const mentions = new Set(extracted.text?.mentions ?? []);
  for (const jid of extracted.mentionedJids) {
    const digits = (jid.split('@')[0] ?? '').split(':')[0] ?? '';
    if (/^\d{8,15}$/.test(digits)) mentions.add(digits);
  }

  const timestamp = toNumber(message.messageTimestamp);

  const [stored] = await db
    .insert(channelMessages)
    .values({
      organizationId: info.organizationId,
      channelId,
      externalMessageId,
      direction: 'INBOUND',
      kind: extracted.kind,
      deliveryStatus: 'RECEIVED',
      fromAddress: peer,
      toAddress: group ? chatJid : ownAddress,
      content: extracted.text?.text ?? null, // lossless: *bold*, _italic_, ~strike~, ```code``` stay exactly as sent
      entities: extracted.text?.entities ?? [],
      links: extracted.text?.links ?? [],
      mentions: [...mentions],
      media: extracted.media,
      sentAt: timestamp ? new Date(timestamp * 1000) : new Date(),
    })
    .onConflictDoNothing()
    .returning({ id: channelMessages.id });

  if (!stored) return; // WhatsApp delivered it twice: do the rest only once

  // "STOP" from a person, in a direct chat, is honoured immediately and permanently.
  if (!group && extracted.kind === 'TEXT' && extracted.text && OPT_OUT.test(extracted.text.text)) {
    await db.insert(channelOptOuts).values({ channelId, address: peer, reason: 'KEYWORD' }).onConflictDoNothing();
  }

  // Blue ticks: not for everything, not at once, and one read per burst of messages.
  if (HumanizerService.shouldSendReadReceipt(group)) {
    await enqueueMarkRead(
      channelId,
      chatJid,
      { id: externalMessageId, participant: message.key.participant },
      HumanizerService.readReceiptDelayMs(group),
    );
  }
}

/**
 * Registers the listener on a freshly created socket. A reconnect creates a new socket, and this
 * is called again for it; the old socket (and its listener) is discarded with it.
 */
export function attachInboundHandlers(sock: WASocket, channelId: string): void {
  sock.ev.on('messages.upsert', ({ messages, type }) => {
    // "notify" is live traffic. Anything else is history being replayed: not new, not ours to answer.
    if (type !== 'notify') return;

    void (async () => {
      for (const message of messages) {
        try {
          await handleMessage(sock, channelId, message);
        } catch (error) {
          console.error(`❌ [Inbound] A message could not be handled: ${error instanceof Error ? error.message : 'unknown error'}`);
        }
      }
    })();
  });
}