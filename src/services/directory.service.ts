// path: src/services/directory.service.ts

import { and, desc, eq, ilike, sql } from 'drizzle-orm';
import { db } from '../config/database.js';
import { channelMessages } from '../db/schema.js';
import { ApiError } from '../utils/api.error.js';
import { ChannelService } from './channel.service.js';
import { waSessionManager } from './wa-session.manager.js';

/**
 * "Who can I send to?" for the automation form, so nobody types numbers by hand.
 *
 *  - groups:   read live from WhatsApp (the number must be online). Cached for a minute per channel,
 *              because fetching every group is a heavy call and the form may open several times.
 *  - contacts: people this number has already exchanged messages with, newest first. Derived from our own
 *              message history, so it needs no extra WhatsApp call and works while the number is offline.
 */

export interface GroupItem {
  id: string;
  name: string;
  size: number;
}

export interface ContactItem {
  /** Full address, ready to be used as a target or an audience entry. */
  jid: string;
  /** Digits only, for display. */
  number: string;
  lastMessageAt: string;
  messages: number;
}

const GROUP_CACHE_MS = 60_000;
const groupCache = new Map<string, { at: number; items: GroupItem[] }>();

export class DirectoryService {
  public static async listGroups(organizationId: string, channelId: string, refresh = false): Promise<GroupItem[]> {
    await ChannelService.get(organizationId, channelId); // 404 for a channel of another organization

    const cached = groupCache.get(channelId);
    if (!refresh && cached && Date.now() - cached.at < GROUP_CACHE_MS) return cached.items;

    const socket = waSessionManager.getSocket(channelId);
    if (!socket || !waSessionManager.isConnected(channelId)) {
      throw ApiError.badRequest('Connect this number first to see its groups.', 'CHANNEL_NOT_CONNECTED');
    }

    const all = await socket.groupFetchAllParticipating();
    const items = Object.values(all)
      .map((group) => ({ id: group.id, name: group.subject || group.id, size: group.participants?.length ?? 0 }))
      .sort((a, b) => a.name.localeCompare(b.name));

    groupCache.set(channelId, { at: Date.now(), items });
    return items;
  }

  public static async listContacts(
    organizationId: string,
    channelId: string,
    { search, limit }: { search?: string | undefined; limit: number },
  ): Promise<ContactItem[]> {
    await ChannelService.get(organizationId, channelId);

    // The other side of each message: who wrote to us, or who we wrote to.
    const peer = sql<string>`case when ${channelMessages.direction} = 'OUTBOUND' then ${channelMessages.toAddress} else ${channelMessages.fromAddress} end`;
    const digits = search?.replace(/\D/g, '');

    const rows = await db
      .select({
        jid: peer,
        lastMessageAt: sql<Date>`max(${channelMessages.createdAt})`,
        messages: sql<number>`count(*)::int`,
      })
      .from(channelMessages)
      .where(
        and(
          eq(channelMessages.organizationId, organizationId),
          eq(channelMessages.channelId, channelId),
          // Real people only: no groups, statuses or broadcast lists.
          sql`${peer} like '%@s.whatsapp.net'`,
          digits ? ilike(peer, `%${digits}%`) : undefined,
        ),
      )
      .groupBy(peer)
      .orderBy(desc(sql`max(${channelMessages.createdAt})`))
      .limit(limit);

    return rows.map((row) => ({
      jid: row.jid,
      number: row.jid.split('@')[0]!.split(':')[0]!,
      lastMessageAt: new Date(row.lastMessageAt).toISOString(),
      messages: row.messages,
    }));
  }
}
