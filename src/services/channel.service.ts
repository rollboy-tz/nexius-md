// path: src/services/channel.service.ts

import { and, asc, count, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { hasOrgPermission, hasPlatformRole, type Permission } from '../auth/permissions.js';
import { db } from '../config/database.js';
import { resolveLimits } from '../config/plans.js';
import { loadSafetySettings, safetySettingsSchema, type SafetySettingsPatch } from '../config/safety.js';
import {
  channelCredentials,
  channels,
  organizations,
  type ChannelProvider,
  type ChannelStatus,
  type OrgRole,
  type PlatformRole,
} from '../db/schema.js';
import { ApiError } from '../utils/api.error.js';
import { isUniqueViolation } from '../utils/db-errors.js';
import { AuditService, type RequestMeta } from './audit.service.js';
import { AuthSessionService, isUuid } from './auth-session.service.js';
import { appEvents, type ChannelStatusPayload } from './session-events.js';
import { waSessionManager } from './wa-session.manager.js';

/* ============================================================================
 * Types
 * ========================================================================== */

/** Providers that actually have an implementation. The enum may list more; only these can be created. */
export const SUPPORTED_PROVIDERS = ['WHATSAPP'] as const satisfies readonly ChannelProvider[];
export type SupportedProvider = (typeof SUPPORTED_PROVIDERS)[number];

export type RealtimePermission = Extract<Permission, 'channel:read' | 'channel:manage'>;

export interface ChannelActor {
  userId: string;
  role: OrgRole;
}

export interface RealtimeCaller {
  userId: string;
  platformRole: PlatformRole;
}

export interface ChannelView {
  id: string;
  organizationId: string;
  provider: ChannelProvider;
  displayName: string;
  externalId: string | null;
  status: ChannelStatus;
  statusReason: string | null;
  metadata: Record<string, unknown>;
  lastConnectedAt: Date | null;
  /** Safety settings (time zone, working hours, cold outreach, humanising, daily cap). */
  settings: Record<string, unknown>;
  createdAt: Date;
}

const CHANNEL_VIEW = {
  id: channels.id,
  organizationId: channels.organizationId,
  provider: channels.provider,
  displayName: channels.displayName,
  externalId: channels.externalId,
  status: channels.status,
  statusReason: channels.statusReason,
  metadata: channels.metadata,
  lastConnectedAt: channels.lastConnectedAt,
  settings: channels.settings,
  createdAt: channels.createdAt,
} as const;

/** Baileys lifecycle state -> provider-neutral channel status. */
const STATE_MAP: Readonly<Record<string, ChannelStatus>> = {
  IDLE: 'PENDING',
  CONNECTING: 'CONNECTING',
  AWAITING_PAIRING: 'AWAITING_AUTH',
  CONNECTED: 'CONNECTED',
  RECONNECTING: 'RECONNECTING',
  DISCONNECTED: 'DISCONNECTED',
  LOGGED_OUT: 'LOGGED_OUT',
  FAILED: 'FAILED',
  STOPPED: 'STOPPED',
};

/** Statuses a session is restored from after a restart. AWAITING_AUTH is not: pairing codes expire. */
const RESTORABLE: readonly ChannelStatus[] = ['CONNECTED', 'RECONNECTING'];

/* ============================================================================
 * Service
 *
 * Ownership rule: a channel belongs to exactly one organization, and EVERY query that takes a
 * channel id also filters by organization id. A valid id from another tenant is simply "not found"
 * (no IDOR), never "forbidden".
 * ========================================================================== */

export class ChannelService {
  /**
   * While true, status events are not persisted. A graceful shutdown stops every session and would
   * otherwise overwrite CONNECTED with STOPPED, leaving nothing to restore on the next boot.
   */
  private static shuttingDown = false;

  public static beginShutdown(): void {
    this.shuttingDown = true;
  }

  /* ------------------------------- lifecycle ------------------------------- */

  public static async create(
    organizationId: string,
    actor: ChannelActor,
    dto: { provider: SupportedProvider; displayName: string },
    meta: RequestMeta,
  ): Promise<ChannelView> {
    if (!(SUPPORTED_PROVIDERS as readonly string[]).includes(dto.provider)) {
      throw ApiError.badRequest('This provider is not supported yet.', 'PROVIDER_NOT_SUPPORTED');
    }

    const displayName = dto.displayName.trim();
    if (displayName.length < 2 || displayName.length > 100) {
      throw ApiError.badRequest('Name must be between 2 and 100 characters.', 'INVALID_CHANNEL_NAME');
    }

    return db.transaction(async (tx) => {
      // The organization row lock serialises concurrent creates, so the plan limit cannot be raced past.
      const [org] = await tx
        .select({
          status: organizations.status,
          planType: organizations.planType,
          limitOverrides: organizations.limitOverrides,
        })
        .from(organizations)
        .where(and(eq(organizations.id, organizationId), isNull(organizations.deletedAt)))
        .for('update');

      if (!org) throw ApiError.notFound('Organization not found.', 'ORGANIZATION_NOT_FOUND');
      if (org.status !== 'ACTIVE') throw ApiError.forbidden('This organization is suspended.', 'ORGANIZATION_SUSPENDED');

      const limits = resolveLimits(org.planType, org.limitOverrides);
      const [used] = await tx
        .select({ value: count() })
        .from(channels)
        .where(and(eq(channels.organizationId, organizationId), isNull(channels.deletedAt)));

      if ((used?.value ?? 0) >= limits.maxChannels) {
        throw ApiError.forbidden('Your plan has reached its connected account limit.', 'PLAN_LIMIT_CHANNELS');
      }

      const [created] = await tx
        .insert(channels)
        .values({ organizationId, provider: dto.provider, displayName, createdByUserId: actor.userId })
        .returning(CHANNEL_VIEW);

      if (!created) throw ApiError.internal('Could not create the channel.', 'CHANNEL_CREATE_FAILED');

      await AuditService.record(
        {
          organizationId,
          actorUserId: actor.userId,
          action: 'channel.created',
          targetType: 'channel',
          targetId: created.id,
          metadata: { provider: dto.provider },
          meta,
        },
        tx,
      );

      return created;
    });
  }

  public static list(organizationId: string): Promise<ChannelView[]> {
    return db
      .select(CHANNEL_VIEW)
      .from(channels)
      .where(and(eq(channels.organizationId, organizationId), isNull(channels.deletedAt)))
      .orderBy(asc(channels.createdAt));
  }

  /** Also the guard for connect / pair / disconnect routes: call it before touching the session. */
  public static async get(organizationId: string, channelId: string): Promise<ChannelView> {
    if (!isUuid(channelId)) throw ApiError.notFound('Channel not found.', 'CHANNEL_NOT_FOUND');

    const [channel] = await db
      .select(CHANNEL_VIEW)
      .from(channels)
      .where(and(eq(channels.id, channelId), eq(channels.organizationId, organizationId), isNull(channels.deletedAt)))
      .limit(1);

    if (!channel) throw ApiError.notFound('Channel not found.', 'CHANNEL_NOT_FOUND');
    return channel;
  }

  public static async rename(
    organizationId: string,
    actor: ChannelActor,
    channelId: string,
    displayName: string,
    meta: RequestMeta,
  ): Promise<ChannelView> {
    const name = displayName.trim();
    if (name.length < 2 || name.length > 100) {
      throw ApiError.badRequest('Name must be between 2 and 100 characters.', 'INVALID_CHANNEL_NAME');
    }
    await this.get(organizationId, channelId);

    return db.transaction(async (tx) => {
      const [updated] = await tx
        .update(channels)
        .set({ displayName: name })
        .where(and(eq(channels.id, channelId), eq(channels.organizationId, organizationId), isNull(channels.deletedAt)))
        .returning(CHANNEL_VIEW);

      if (!updated) throw ApiError.notFound('Channel not found.', 'CHANNEL_NOT_FOUND');

      await AuditService.record(
        { organizationId, actorUserId: actor.userId, action: 'channel.renamed', targetType: 'channel', targetId: channelId, meta },
        tx,
      );
      return updated;
    });
  }

  /**
   * Changes how carefully this number behaves. A customer can only make it MORE careful: the daily cap
   * can be lowered but never raised above the warm-up schedule (see config/safety.ts).
   */
  public static async updateSettings(
    organizationId: string,
    actor: ChannelActor,
    channelId: string,
    patch: SafetySettingsPatch,
    meta: RequestMeta,
  ): Promise<ChannelView> {
    const current = await this.get(organizationId, channelId);

    // Stored settings may be empty or from an older version: start from the effective values, then apply the change.
    const merged = safetySettingsSchema.parse({ ...loadSafetySettings(current.settings), ...patch });

    return db.transaction(async (tx) => {
      const [updated] = await tx
        .update(channels)
        .set({ settings: merged })
        .where(and(eq(channels.id, channelId), eq(channels.organizationId, organizationId), isNull(channels.deletedAt)))
        .returning(CHANNEL_VIEW);

      if (!updated) throw ApiError.notFound('Channel not found.', 'CHANNEL_NOT_FOUND');

      await AuditService.record(
        {
          organizationId,
          actorUserId: actor.userId,
          action: 'channel.settings_updated',
          targetType: 'channel',
          targetId: channelId,
          metadata: { changed: Object.keys(patch) },
          meta,
        },
        tx,
      );
      return updated;
    });
  }

  /**
   * Soft delete: stops the live session and destroys stored credentials. The device stays linked
   * on the owner's phone until they remove it in WhatsApp (or until bailey.service calls logout()).
   */
  public static async remove(organizationId: string, actor: ChannelActor, channelId: string, meta: RequestMeta): Promise<void> {
    await db.transaction(async (tx) => {
      const [removed] = await tx
        .update(channels)
        .set({ deletedAt: new Date(), status: 'STOPPED', statusReason: 'Removed by a member.', externalId: null })
        .where(and(eq(channels.id, channelId), eq(channels.organizationId, organizationId), isNull(channels.deletedAt)))
        .returning({ id: channels.id });

      if (!removed) throw ApiError.notFound('Channel not found.', 'CHANNEL_NOT_FOUND');

      await tx.delete(channelCredentials).where(eq(channelCredentials.channelId, channelId));
      await AuditService.record(
        { organizationId, actorUserId: actor.userId, action: 'channel.deleted', targetType: 'channel', targetId: channelId, meta },
        tx,
      );
    });

    await this.stopSessions([channelId]);
  }

  /* ------------------------------ realtime access ------------------------------ */

  /**
   * Decides whether a Socket.IO client may watch (channel:read) or clear (channel:manage) a
   * channel's live logs. The channel id is the room name, so this is the only thing standing
   * between a guessed id and someone else's pairing code.
   *
   * Platform staff may READ any channel for support. They never get write access this way.
   */
  public static async authorizeRealtimeAccess(
    caller: RealtimeCaller,
    channelId: string,
    permission: RealtimePermission,
  ): Promise<boolean> {
    if (!isUuid(channelId)) return false;

    const [channel] = await db
      .select({ organizationId: channels.organizationId })
      .from(channels)
      .where(and(eq(channels.id, channelId), isNull(channels.deletedAt)))
      .limit(1);

    if (!channel) return false;

    const org = await AuthSessionService.getOrgContext(caller.userId, channel.organizationId);
    if (org && org.organizationStatus === 'ACTIVE' && hasOrgPermission(org.role, permission)) return true;

    return permission === 'channel:read' && hasPlatformRole(caller.platformRole, 'SUPPORT');
  }

  /* -------------------------- status sync (from bailey) -------------------------- */

  /** Call once at startup, after the database is ready. */
  public static startStatusSync(): void {
    appEvents.onChannelStatus((channelId, payload) => {
      void this.persistStatus(channelId, payload);
    });
  }

  public static async persistStatus(channelId: string, payload: ChannelStatusPayload): Promise<void> {
    if (this.shuttingDown || !isUuid(channelId)) return;

    const status: ChannelStatus | undefined = STATE_MAP[payload.state];
    if (!status) return;

    const phoneNumber = payload.profile?.phoneNumber ?? payload.phoneNumber ?? null;

    try {
      await db
        .update(channels)
        .set({
          status,
          statusReason: status === 'LOGGED_OUT' ? 'The device was unlinked from WhatsApp.' : (payload.message ?? null),
          // An unlinked number is released so another organization can connect it.
          ...(status === 'LOGGED_OUT' ? { externalId: null } : {}),
          ...(status === 'CONNECTED'
            ? {
                lastConnectedAt: new Date(),
                // Set once, on the very first connection. It starts the warm-up clock.
                firstConnectedAt: sql`coalesce(${channels.firstConnectedAt}, now())`,
                ...(phoneNumber ? { externalId: phoneNumber } : {}),
                ...(payload.profile
                  ? { metadata: { jid: payload.profile.jid, lid: payload.profile.lid, name: payload.profile.name } }
                  : {}),
              }
            : {}),
        })
        .where(and(eq(channels.id, channelId), isNull(channels.deletedAt)));
    } catch (error) {
      if (isUniqueViolation(error, 'channels_provider_external_uq')) {
        // The same WhatsApp number is already connected in another organization. Refuse it here.
        await db
          .update(channels)
          .set({ status: 'FAILED', statusReason: 'This number is already connected to another organization.' })
          .where(eq(channels.id, channelId));
        await waSessionManager.removeSession(channelId);
        return;
      }

      console.error(`❌ [Channel] Could not persist status for ${channelId}:`, error);
    }
  }

  /* ------------------------------- boot & stop ------------------------------- */

  /** Channels to bring back after a restart: connected when we went down, in a healthy organization. */
  public static async listRestorable(): Promise<Array<{ id: string; phoneNumber: string | null }>> {
    const rows = await db
      .select({ id: channels.id, phoneNumber: channels.externalId })
      .from(channels)
      .innerJoin(organizations, eq(organizations.id, channels.organizationId))
      .where(
        and(
          eq(channels.provider, 'WHATSAPP'),
          inArray(channels.status, [...RESTORABLE]),
          isNull(channels.deletedAt),
          eq(organizations.status, 'ACTIVE'),
          isNull(organizations.deletedAt),
        ),
      );

    return rows;
  }

  /**
   * Boot-time restore. Sequential on purpose: every restore calls WhatsApp, and a stampede at
   * startup is exactly when it tolerates one least. It lives here, not in session.manager, so
   * session.manager never has to import this service (that would be a circular import).
   */
  public static async restoreAll(): Promise<void> {
    const restorable = await this.listRestorable();
    console.log(`📋 [Channel] Restoring ${restorable.length} session(s)...`);

    for (const channel of restorable) {
      try {
        await waSessionManager.getOrCreateSession(channel.id, channel.phoneNumber ?? undefined);
      } catch (error) {
        console.error(`❌ [Channel] Failed to restore ${channel.id}:`, error);
      }
    }
  }

  public static async stopSessions(channelIds: readonly string[]): Promise<void> {
    const results = await Promise.allSettled(channelIds.map((id) => waSessionManager.removeSession(id)));

    results.forEach((result, index) => {
      if (result.status === 'rejected') console.error(`⚠️ [Channel] Could not stop ${channelIds[index]}:`, result.reason);
    });
  }

  public static async stopAllForOrganization(organizationId: string): Promise<void> {
    const rows = await db
      .select({ id: channels.id })
      .from(channels)
      .where(and(eq(channels.organizationId, organizationId), isNull(channels.deletedAt), ne(channels.status, 'STOPPED')));

    await this.stopSessions(rows.map((row) => row.id));
  }
}