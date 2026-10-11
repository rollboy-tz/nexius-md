// path: src/services/message.service.ts

import type { MiscMessageGenerationOptions, proto, WAMessage, WASocket } from '@whiskeysockets/baileys';
import { redis } from '../config/redis.js';
import { ApiError } from '../utils/api.error.js';
import { phoneToJid, STATUS_JID } from '../utils/jid.util.js';

/**
 * Talks to WhatsApp, nothing else. Timing, limits and safety live in the worker and the policy,
 * so a message can only leave through the one path that enforces them.
 *
 * Compared with the previous version:
 *  - no sleeping in here (the worker orchestrates human timing once, not twice)
 *  - images are sent as bytes we downloaded safely, never as a URL Baileys would fetch (SSRF)
 *  - recipients are resolved by utils/jid.util, which understands groups and LIDs
 *  - logs carry no phone numbers or message text
 */

const confirmedId = (result: proto.IWebMessageInfo | undefined): string => {
  const id = result?.key?.id;
  if (!id) throw ApiError.internal('WhatsApp did not confirm the message.', 'MESSAGE_SEND_FAILED');
  return id;
};

export interface ReadKey {
  id: string;
  remoteJid: string;
  participant?: string | null | undefined;
}

export class MessageService {
  /** Video, voice notes and round video notes are out of scope for this version: never processed, never stored. */
  public static isSupportedInboundMessage(message: WAMessage): boolean {
    const content = message.message;
    if (!content) return false;
    return !(content.audioMessage || content.videoMessage || content.ptvMessage);
  }

  public static async sendText(sock: WASocket, jid: string, text: string, mentions: readonly string[] = []): Promise<string> {
    const result = await sock.sendMessage(jid, {
      text,
      ...(mentions.length > 0 ? { mentions: mentions.map(phoneToJid) } : {}),
    });
    return confirmedId(result);
  }

  public static async sendImage(sock: WASocket, jid: string, image: Buffer, caption?: string): Promise<string> {
    const result = await sock.sendMessage(jid, { image, ...(caption ? { caption } : {}) });
    return confirmedId(result);
  }

  /** `audience` is the list of people who can see it. WhatsApp shows a status to nobody without one. */
  public static async sendStatusText(
    sock: WASocket,
    text: string,
    audience: readonly string[],
    style: { backgroundColor?: string | undefined; font?: number | undefined } = {},
  ): Promise<string> {
    const options = {
      statusJidList: [...audience],
      ...(style.backgroundColor ? { backgroundColor: style.backgroundColor } : {}),
      ...(style.font !== undefined ? { font: style.font } : {}),
    } as MiscMessageGenerationOptions;

    return confirmedId(await sock.sendMessage(STATUS_JID, { text }, options));
  }

  public static async sendStatusImage(
    sock: WASocket,
    image: Buffer,
    caption: string | undefined,
    audience: readonly string[],
  ): Promise<string> {
    const options = { statusJidList: [...audience] } as MiscMessageGenerationOptions;
    return confirmedId(await sock.sendMessage(STATUS_JID, { image, ...(caption ? { caption } : {}) }, options));
  }

  /** Blue ticks, or the "seen" of a status. Failure is not fatal: it is cosmetic. */
  public static async markRead(sock: WASocket, keys: readonly ReadKey[]): Promise<void> {
    if (keys.length === 0) return;

    await sock.readMessages(
      keys.map((key) => ({
        remoteJid: key.remoteJid,
        id: key.id,
        fromMe: false,
        ...(key.participant ? { participant: key.participant } : {}),
      })),
    );
  }

  /**
   * Messaging numbers that are not on WhatsApp is a ban signal. The answer is cached
   * (a day when yes, six hours when no) so the same number is not asked about repeatedly.
   */
  public static async isOnWhatsApp(sock: WASocket, jid: string): Promise<boolean> {
    const cacheKey = `wa:exists:${jid}`;
    const cached = await redis.get(cacheKey);
    if (cached !== null) return cached === '1';

    const [entry] = (await sock.onWhatsApp(jid)) ?? [];
    const exists = Boolean(entry?.exists);

    await redis.set(cacheKey, exists ? '1' : '0', 'EX', exists ? 86_400 : 21_600);
    return exists;
  }
}