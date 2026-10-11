// path: src/services/admin.service.ts

import { and, asc, count, desc, eq, ilike, isNull, or, sql } from 'drizzle-orm';
import { hasPlatformRole } from '../auth/permissions.js';
import { db } from '../config/database.js';
import { PLAN_TYPES, type PlanLimits, type PlanType } from '../config/plans.js';
import { StatusCodes } from '../constants/status-codes.js';
import {
  channels,
  organizationMembers,
  organizations,
  users,
  type AccountStatus,
  type ChannelProvider,
  type ChannelStatus,
  type OrganizationStatus,
  type PlatformRole,
} from '../db/schema.js';
import { ApiError } from '../utils/api.error.js';
import { AuditService, type AuditQuery, type RequestMeta } from './audit.service.js';
import { AuthSessionService } from './auth-session.service.js';
import { ChannelService, type ChannelView } from './channel.service.js';
import type { Paginated } from './organization.service.js';
import { TokenService } from './token.service.js';

/* ============================================================================
 * Types
 * ========================================================================== */

export interface PlatformActor {
  userId: string;
  platformRole: PlatformRole;
}

export interface AdminPage {
  page?: number | undefined;
  limit?: number | undefined;
  search?: string | undefined;
}

export interface AdminOrganizationRow {
  id: string;
  name: string;
  slug: string;
  planType: PlanType;
  status: OrganizationStatus;
  createdAt: Date;
  memberCount: number;
  channelCount: number;
}

export interface AdminUserRow {
  id: string;
  email: string;
  fullName: string;
  platformRole: PlatformRole;
  status: AccountStatus;
  lastLoginAt: Date | null;
  createdAt: Date;
  organizationCount: number;
}

export interface AdminChannelRow extends ChannelView {
  organizationName: string;
}

export interface PlanChange {
  planType: PlanType;
  /** undefined = leave as is, null = remove overrides, object = replace. */
  limitOverrides?: Partial<PlanLimits> | null | undefined;
}

const LIMIT_KEYS: readonly (keyof PlanLimits)[] = ['maxChannels', 'maxMembers', 'maxApiKeys', 'messagesPerDay'];

/* ============================================================================
 * Helpers
 * ========================================================================== */

const escapeLike = (value: string): string => value.replace(/[\\%_]/g, '\\$&');
const conflict = (message: string, code: string): ApiError => new ApiError(StatusCodes.CONFLICT, message, code);

function paginate(query: AdminPage): { page: number; limit: number; offset: number; pattern: string | null } {
  const page = Math.max(1, query.page ?? 1);
  const limit = Math.min(100, Math.max(1, query.limit ?? 25));
  const search = query.search?.trim();

  return { page, limit, offset: (page - 1) * limit, pattern: search ? `%${escapeLike(search)}%` : null };
}

const toPage = <T>(data: T[], total: number, page: number, limit: number): Paginated<T> => ({
  data,
  meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
});

/** Destructive platform actions must say why. The reason is stored in the audit log. */
function assertReason(reason: string): string {
  const clean = reason.trim();
  if (clean.length < 5 || clean.length > 500) {
    throw ApiError.badRequest('A reason of 5 to 500 characters is required.', 'REASON_REQUIRED');
  }
  return clean;
}

/**
 * Staff roles: SUPPORT reads, SUPER_ADMIN reads and writes. The route middleware already hides
 * /admin from everyone else; this re-checks inside the service so a mis-wired route cannot grant writes.
 */
function assertSuperAdmin(actor: PlatformActor): void {
  if (!hasPlatformRole(actor.platformRole, 'SUPER_ADMIN')) {
    throw ApiError.forbidden('This action requires a super administrator.', 'FORBIDDEN');
  }
}

function assertStaff(actor: PlatformActor): void {
  if (!hasPlatformRole(actor.platformRole, 'SUPPORT')) {
    throw ApiError.forbidden('Platform staff only.', 'FORBIDDEN');
  }
}

/* ============================================================================
 * Service
 *
 * Design rules:
 *  - no impersonation and no "act as member": staff see and change resources through these
 *    explicit, audited operations only, never by borrowing a customer's identity
 *  - every write is SUPER_ADMIN only, needs a reason when destructive, and is audited
 *  - staff can never act on their own account, and the last SUPER_ADMIN can never be removed
 * ========================================================================== */

export class AdminService {
  /* -------------------------------- overview -------------------------------- */

  public static async overview(actor: PlatformActor) {
    assertStaff(actor);

    const [userCount, organizationCount, channelCount, connectedCount] = await Promise.all([
      db.select({ value: count() }).from(users).where(isNull(users.deletedAt)),
      db.select({ value: count() }).from(organizations).where(isNull(organizations.deletedAt)),
      db.select({ value: count() }).from(channels).where(isNull(channels.deletedAt)),
      db.select({ value: count() }).from(channels).where(and(isNull(channels.deletedAt), eq(channels.status, 'CONNECTED'))),
    ]);

    return {
      users: userCount[0]?.value ?? 0,
      organizations: organizationCount[0]?.value ?? 0,
      channels: channelCount[0]?.value ?? 0,
      connectedChannels: connectedCount[0]?.value ?? 0,
    };
  }

  /* ------------------------------ organizations ------------------------------ */

  public static async listOrganizations(
    actor: PlatformActor,
    query: AdminPage & { status?: OrganizationStatus | undefined },
  ): Promise<Paginated<AdminOrganizationRow>> {
    assertStaff(actor);
    const { page, limit, offset, pattern } = paginate(query);

    const where = and(
      isNull(organizations.deletedAt),
      query.status ? eq(organizations.status, query.status) : undefined,
      pattern ? or(ilike(organizations.name, pattern), ilike(organizations.slug, pattern)) : undefined,
    );

    const [totals, rows] = await Promise.all([
      db.select({ value: count() }).from(organizations).where(where),
      db
        .select({
          id: organizations.id,
          name: organizations.name,
          slug: organizations.slug,
          planType: organizations.planType,
          status: organizations.status,
          createdAt: organizations.createdAt,
          memberCount: sql<number>`(select count(*) from ${organizationMembers} where ${organizationMembers.organizationId} = ${organizations.id})`.mapWith(Number),
          channelCount: sql<number>`(select count(*) from ${channels} where ${channels.organizationId} = ${organizations.id} and ${channels.deletedAt} is null)`.mapWith(Number),
        })
        .from(organizations)
        .where(where)
        .orderBy(desc(organizations.createdAt))
        .limit(limit)
        .offset(offset),
    ]);

    return toPage(rows, totals[0]?.value ?? 0, page, limit);
  }

  public static async getOrganization(actor: PlatformActor, organizationId: string) {
    assertStaff(actor);

    const [organization] = await db
      .select()
      .from(organizations)
      .where(and(eq(organizations.id, organizationId), isNull(organizations.deletedAt)))
      .limit(1);

    if (!organization) throw ApiError.notFound('Organization not found.', 'ORGANIZATION_NOT_FOUND');

    const [owners, members, channelList] = await Promise.all([
      db
        .select({ userId: users.id, fullName: users.fullName, email: users.email })
        .from(organizationMembers)
        .innerJoin(users, eq(users.id, organizationMembers.userId))
        .where(and(eq(organizationMembers.organizationId, organizationId), eq(organizationMembers.role, 'OWNER'))),
      db.select({ value: count() }).from(organizationMembers).where(eq(organizationMembers.organizationId, organizationId)),
      ChannelService.list(organizationId),
    ]);

    return { organization, owners, memberCount: members[0]?.value ?? 0, channels: channelList };
  }

  public static async setOrganizationStatus(
    actor: PlatformActor,
    organizationId: string,
    status: OrganizationStatus,
    reason: string,
    meta: RequestMeta,
  ): Promise<void> {
    assertSuperAdmin(actor);
    const why = assertReason(reason);

    await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(organizations)
        .set(
          status === 'SUSPENDED'
            ? { status, suspendedAt: new Date(), suspendedReason: why }
            : { status, suspendedAt: null, suspendedReason: null },
        )
        .where(and(eq(organizations.id, organizationId), isNull(organizations.deletedAt)))
        .returning({ id: organizations.id });

      if (!updated) throw ApiError.notFound('Organization not found.', 'ORGANIZATION_NOT_FOUND');

      await AuditService.record(
        {
          organizationId,
          actorUserId: actor.userId,
          action: status === 'SUSPENDED' ? 'admin.organization_suspended' : 'admin.organization_reactivated',
          targetType: 'organization',
          targetId: organizationId,
          metadata: { reason: why },
          meta,
        },
        tx,
      );
    });

    await AuthSessionService.invalidateOrganization(organizationId);

    // A suspended organization must stop sending messages right now, not at the next deploy.
    // Reactivation does not auto-restart sessions: members reconnect deliberately.
    if (status === 'SUSPENDED') await ChannelService.stopAllForOrganization(organizationId);
  }

  public static async changePlan(actor: PlatformActor, organizationId: string, change: PlanChange, meta: RequestMeta): Promise<void> {
    assertSuperAdmin(actor);

    if (!(PLAN_TYPES as readonly string[]).includes(change.planType)) {
      throw ApiError.badRequest('Unknown plan.', 'INVALID_PLAN');
    }

    if (change.limitOverrides) {
      for (const [key, value] of Object.entries(change.limitOverrides)) {
        if (
          !(LIMIT_KEYS as readonly string[]).includes(key) ||
          typeof value !== 'number' ||
          !Number.isInteger(value) ||
          value < 0 ||
          value > 10_000_000
        ) {
          throw ApiError.badRequest(`Invalid limit override: ${key}.`, 'INVALID_LIMIT_OVERRIDE');
        }
      }
    }

    await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(organizations)
        .set({
          planType: change.planType,
          ...(change.limitOverrides !== undefined ? { limitOverrides: change.limitOverrides } : {}),
        })
        .where(and(eq(organizations.id, organizationId), isNull(organizations.deletedAt)))
        .returning({ id: organizations.id });

      if (!updated) throw ApiError.notFound('Organization not found.', 'ORGANIZATION_NOT_FOUND');

      await AuditService.record(
        {
          organizationId,
          actorUserId: actor.userId,
          action: 'admin.plan_changed',
          targetType: 'organization',
          targetId: organizationId,
          metadata: { planType: change.planType, limitOverrides: change.limitOverrides ?? null },
          meta,
        },
        tx,
      );
    });

    await AuthSessionService.invalidateOrganization(organizationId);
  }

  /* --------------------------------- users --------------------------------- */

  public static async listUsers(
    actor: PlatformActor,
    query: AdminPage & { status?: AccountStatus | undefined },
  ): Promise<Paginated<AdminUserRow>> {
    assertStaff(actor);
    const { page, limit, offset, pattern } = paginate(query);

    const where = and(
      isNull(users.deletedAt),
      query.status ? eq(users.status, query.status) : undefined,
      pattern ? or(ilike(users.email, pattern), ilike(users.fullName, pattern)) : undefined,
    );

    const [totals, rows] = await Promise.all([
      db.select({ value: count() }).from(users).where(where),
      db
        .select({
          id: users.id,
          email: users.email,
          fullName: users.fullName,
          platformRole: users.platformRole,
          status: users.status,
          lastLoginAt: users.lastLoginAt,
          createdAt: users.createdAt,
          organizationCount: sql<number>`(select count(*) from ${organizationMembers} where ${organizationMembers.userId} = ${users.id})`.mapWith(Number),
        })
        .from(users)
        .where(where)
        .orderBy(desc(users.createdAt))
        .limit(limit)
        .offset(offset),
    ]);

    return toPage(rows, totals[0]?.value ?? 0, page, limit);
  }

  public static async getUser(actor: PlatformActor, userId: string) {
    assertStaff(actor);

    const [user] = await db
      .select({
        id: users.id,
        email: users.email,
        fullName: users.fullName,
        platformRole: users.platformRole,
        status: users.status,
        emailVerifiedAt: users.emailVerifiedAt,
        lastLoginAt: users.lastLoginAt,
        createdAt: users.createdAt,
      })
      .from(users)
      .where(and(eq(users.id, userId), isNull(users.deletedAt)))
      .limit(1);

    if (!user) throw ApiError.notFound('User not found.', 'USER_NOT_FOUND');

    const [memberships, sessions] = await Promise.all([
      db
        .select({
          organizationId: organizations.id,
          organizationName: organizations.name,
          role: organizationMembers.role,
          status: organizationMembers.status,
        })
        .from(organizationMembers)
        .innerJoin(organizations, eq(organizations.id, organizationMembers.organizationId))
        .where(and(eq(organizationMembers.userId, userId), isNull(organizations.deletedAt)))
        .orderBy(asc(organizationMembers.joinedAt)),
      TokenService.listActiveSessions(userId),
    ]);

    return { user, memberships, activeSessionCount: sessions.length };
  }

  /** Account-level suspension: the person is locked out of the whole platform, in every organization. */
  public static async setUserStatus(
    actor: PlatformActor,
    userId: string,
    status: 'ACTIVE' | 'SUSPENDED',
    reason: string,
    meta: RequestMeta,
  ): Promise<void> {
    assertSuperAdmin(actor);
    const why = assertReason(reason);

    if (actor.userId === userId) throw ApiError.badRequest('You cannot change your own account status.', 'SELF_ACTION_PROHIBITED');

    await db.transaction(async (tx) => {
      const [target] = await tx
        .select({ platformRole: users.platformRole, status: users.status, emailVerifiedAt: users.emailVerifiedAt })
        .from(users)
        .where(and(eq(users.id, userId), isNull(users.deletedAt)))
        .for('update');

      if (!target) throw ApiError.notFound('User not found.', 'USER_NOT_FOUND');
      if (target.platformRole === 'SUPER_ADMIN') {
        throw ApiError.forbidden('Demote this super administrator before changing their status.', 'FORBIDDEN');
      }

      // Reactivating never skips email verification.
      const next: AccountStatus = status === 'SUSPENDED' ? 'SUSPENDED' : target.emailVerifiedAt ? 'ACTIVE' : 'PENDING_VERIFICATION';
      await tx.update(users).set({ status: next }).where(eq(users.id, userId));

      await AuditService.record(
        {
          actorUserId: actor.userId,
          action: status === 'SUSPENDED' ? 'admin.user_suspended' : 'admin.user_reactivated',
          targetType: 'user',
          targetId: userId,
          metadata: { reason: why },
          meta,
        },
        tx,
      );
    });

    await AuthSessionService.invalidateUser(userId);
    if (status === 'SUSPENDED') await AuthSessionService.revokeAllUserSessions(userId, 'ACCOUNT_SUSPENDED');
  }

  /** Grants or removes staff access. The platform must always keep at least one SUPER_ADMIN. */
  public static async setPlatformRole(actor: PlatformActor, userId: string, role: PlatformRole, meta: RequestMeta): Promise<void> {
    assertSuperAdmin(actor);

    if (actor.userId === userId) throw ApiError.badRequest('You cannot change your own platform role.', 'SELF_ACTION_PROHIBITED');

    await db.transaction(async (tx) => {
      const superAdmins = await tx
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.platformRole, 'SUPER_ADMIN'), isNull(users.deletedAt)))
        .for('update');

      const [target] = await tx
        .select({ platformRole: users.platformRole, status: users.status })
        .from(users)
        .where(and(eq(users.id, userId), isNull(users.deletedAt)))
        .for('update');

      if (!target) throw ApiError.notFound('User not found.', 'USER_NOT_FOUND');
      if (role !== 'USER' && target.status !== 'ACTIVE') {
        throw conflict('Only active, verified accounts can receive staff roles.', 'TARGET_NOT_ACTIVE');
      }
      if (target.platformRole === 'SUPER_ADMIN' && role !== 'SUPER_ADMIN' && superAdmins.length <= 1) {
        throw conflict('The platform must keep at least one super administrator.', 'LAST_SUPER_ADMIN');
      }

      await tx.update(users).set({ platformRole: role }).where(eq(users.id, userId));

      await AuditService.record(
        {
          actorUserId: actor.userId,
          action: 'admin.platform_role_changed',
          targetType: 'user',
          targetId: userId,
          metadata: { from: target.platformRole, to: role },
          meta,
        },
        tx,
      );
    });

    await AuthSessionService.invalidateUser(userId);
  }

  public static async revokeUserSessions(actor: PlatformActor, userId: string, reason: string, meta: RequestMeta): Promise<void> {
    assertSuperAdmin(actor);
    const why = assertReason(reason);

    await AuthSessionService.revokeAllUserSessions(userId, 'REVOKED_BY_ADMIN');
    await AuditService.record({
      actorUserId: actor.userId,
      action: 'admin.sessions_revoked',
      targetType: 'user',
      targetId: userId,
      metadata: { reason: why },
      meta,
    });
  }

  /* -------------------------------- channels -------------------------------- */

  public static async listChannels(
    actor: PlatformActor,
    query: AdminPage & {
      organizationId?: string | undefined;
      provider?: ChannelProvider | undefined;
      status?: ChannelStatus | undefined;
    },
  ): Promise<Paginated<AdminChannelRow>> {
    assertStaff(actor);
    const { page, limit, offset, pattern } = paginate(query);

    const where = and(
      isNull(channels.deletedAt),
      query.organizationId ? eq(channels.organizationId, query.organizationId) : undefined,
      query.provider ? eq(channels.provider, query.provider) : undefined,
      query.status ? eq(channels.status, query.status) : undefined,
      pattern ? or(ilike(channels.displayName, pattern), ilike(channels.externalId, pattern)) : undefined,
    );

    const [totals, rows] = await Promise.all([
      db.select({ value: count() }).from(channels).where(where),
      db
        .select({
          id: channels.id,
          organizationId: channels.organizationId,
          organizationName: organizations.name,
          provider: channels.provider,
          displayName: channels.displayName,
          externalId: channels.externalId,
          status: channels.status,
          statusReason: channels.statusReason,
          settings: channels.settings,
          metadata: channels.metadata,
          lastConnectedAt: channels.lastConnectedAt,
          createdAt: channels.createdAt,
        })
        .from(channels)
        .innerJoin(organizations, eq(organizations.id, channels.organizationId))
        .where(where)
        .orderBy(desc(channels.createdAt))
        .limit(limit)
        .offset(offset),
    ]);

    return toPage(rows, totals[0]?.value ?? 0, page, limit);
  }

  /** Emergency stop (abuse, ban risk, runaway automation). Credentials are kept; the owner can reconnect. */
  public static async forceStopChannel(actor: PlatformActor, channelId: string, reason: string, meta: RequestMeta): Promise<void> {
    assertSuperAdmin(actor);
    const why = assertReason(reason);

    const [channel] = await db
      .select({ organizationId: channels.organizationId })
      .from(channels)
      .where(and(eq(channels.id, channelId), isNull(channels.deletedAt)))
      .limit(1);

    if (!channel) throw ApiError.notFound('Channel not found.', 'CHANNEL_NOT_FOUND');

    await ChannelService.stopSessions([channelId]);
    await AuditService.record({
      organizationId: channel.organizationId,
      actorUserId: actor.userId,
      action: 'admin.channel_stopped',
      targetType: 'channel',
      targetId: channelId,
      metadata: { reason: why },
      meta,
    });
  }

  /* --------------------------------- audit --------------------------------- */

  public static listAuditLogs(actor: PlatformActor, query: AuditQuery) {
    assertStaff(actor);
    return AuditService.list(query);
  }
}