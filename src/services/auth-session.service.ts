// path: src/services/auth-session.service.ts

import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../config/database.js';
import type { PlanType } from '../config/plans.js';
import {
  organizationMembers,
  organizations,
  users,
  type OrgRole,
  type OrganizationStatus,
  type PlatformRole,
} from '../db/schema.js';
import { ApiError } from '../utils/api.error.js';
import { CacheService } from './cache.service.js';
import { TokenService } from './token.service.js';

/* ============================================================================
 * Types
 * ========================================================================== */

/** Who the user is, independent of any device or organization. */
export interface UserContext {
  userId: string;
  email: string;
  fullName: string;
  platformRole: PlatformRole;
}

/** The authenticated caller: a user on one specific device session. Lives on `req.user`. */
export interface AuthUser extends UserContext {
  sessionId: string;
}

/** The caller's standing inside one organization. Lives on `req.org`. */
export interface OrgContext {
  organizationId: string;
  organizationStatus: OrganizationStatus;
  planType: PlanType;
  role: OrgRole;
}

type CacheEntry<T> = { found: true; value: T } | { found: false };
type OrganizationFacts = { status: OrganizationStatus; planType: PlanType };
type MembershipFacts = { role: OrgRole };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Ids from URLs and sockets are checked before they reach Postgres (a bad uuid would raise a 500). */
export const isUuid = (value: unknown): value is string => typeof value === 'string' && UUID_RE.test(value);

/* ============================================================================
 * Service
 *
 * Request path costs: JWT verify (CPU) + Redis denylist check + Redis user context.
 * No database access on a warm cache. Every cached fact has an explicit invalidation below,
 * and a short TTL as a safety net.
 * ========================================================================== */

export class AuthSessionService {
  private static readonly TTL_SECONDS = 300;
  private static readonly NEGATIVE_TTL_SECONDS = 60; // "does not exist / not allowed" is cached briefly to absorb probing

  private static readonly userKey = (userId: string) => `auth:user:${userId}`;
  private static readonly orgKey = (organizationId: string) => `auth:org:${organizationId}`;
  private static readonly memberKey = (organizationId: string, userId: string) =>
    `auth:member:${organizationId}:${userId}`;

  /** Read-through cache that also remembers "not found". */
  private static async cached<T>(key: string, load: () => Promise<T | null>): Promise<T | null> {
    const entry = await CacheService.get<CacheEntry<T>>(key);
    if (entry) return entry.found ? entry.value : null;

    const value = await load();
    const next: CacheEntry<T> = value === null ? { found: false } : { found: true, value };
    await CacheService.set(key, next, value === null ? this.NEGATIVE_TTL_SECONDS : this.TTL_SECONDS);

    return value;
  }

  /* ------------------------------- loaders ------------------------------- */

  /** Null unless the account exists, is not deleted, and is ACTIVE (verified and not suspended). */
  public static getUserContext(userId: string): Promise<UserContext | null> {
    return this.cached<UserContext>(this.userKey(userId), async () => {
      const [row] = await db
        .select({
          id: users.id,
          email: users.email,
          fullName: users.fullName,
          platformRole: users.platformRole,
          status: users.status,
        })
        .from(users)
        .where(and(eq(users.id, userId), isNull(users.deletedAt)))
        .limit(1);

      if (!row || row.status !== 'ACTIVE') return null;

      return { userId: row.id, email: row.email, fullName: row.fullName, platformRole: row.platformRole };
    });
  }

  private static getOrganizationFacts(organizationId: string): Promise<OrganizationFacts | null> {
    return this.cached<OrganizationFacts>(this.orgKey(organizationId), async () => {
      const [row] = await db
        .select({ status: organizations.status, planType: organizations.planType })
        .from(organizations)
        .where(and(eq(organizations.id, organizationId), isNull(organizations.deletedAt)))
        .limit(1);

      return row ?? null;
    });
  }

  /** Only ACTIVE memberships count; a suspended member is treated exactly like a non-member. */
  private static getMembershipFacts(organizationId: string, userId: string): Promise<MembershipFacts | null> {
    return this.cached<MembershipFacts>(this.memberKey(organizationId, userId), async () => {
      const [row] = await db
        .select({ role: organizationMembers.role })
        .from(organizationMembers)
        .where(
          and(
            eq(organizationMembers.organizationId, organizationId),
            eq(organizationMembers.userId, userId),
            eq(organizationMembers.status, 'ACTIVE'),
          ),
        )
        .limit(1);

      return row ?? null;
    });
  }

  /**
   * The user's standing in an organization, or null when the organization does not exist or the
   * user is not an active member. Callers answer 404 for null so organization ids cannot be probed.
   */
  public static async getOrgContext(userId: string, organizationId: string): Promise<OrgContext | null> {
    if (!isUuid(organizationId)) return null;

    const [organization, membership] = await Promise.all([
      this.getOrganizationFacts(organizationId),
      this.getMembershipFacts(organizationId, userId),
    ]);

    if (!organization || !membership) return null;

    return {
      organizationId,
      organizationStatus: organization.status,
      planType: organization.planType,
      role: membership.role,
    };
  }

  /* --------------------------- access token entry --------------------------- */

  /**
   * The single place that turns a bearer token into a caller. Used by the HTTP middleware and by
   * the Socket.IO handshake, so both enforce identical rules:
   * signature + expiry -> session not revoked -> account still active.
   */
  public static async resolveAccessToken(token: string): Promise<AuthUser> {
    const { userId, sessionId } = TokenService.verifyAccessToken(token);

    if (await TokenService.isSessionDenied(sessionId)) {
      throw ApiError.unauthorized('Session has been revoked', 'SESSION_REVOKED');
    }

    const user = await this.getUserContext(userId);
    if (!user) {
      throw ApiError.unauthorized('Account is unavailable', 'ACCOUNT_UNAVAILABLE');
    }

    return { ...user, sessionId };
  }

  /* ---------------------------- invalidation ---------------------------- */

  /** Call after: status change (suspend/reactivate), role change, profile change, email verification. */
  public static async invalidateUser(userId: string): Promise<void> {
    await CacheService.del(this.userKey(userId));
  }

  /** Call after: role change, member removal, member suspension, accepting an invite. */
  public static async invalidateMembership(organizationId: string, userId: string): Promise<void> {
    await CacheService.del(this.memberKey(organizationId, userId));
  }

  /** Call after: organization suspension/reactivation, plan change, soft delete. */
  public static async invalidateOrganization(organizationId: string): Promise<void> {
    await CacheService.del(this.orgKey(organizationId));
  }

  /* ------------------------------ sessions ------------------------------ */

  public static revokeSession(sessionId: string, reason: string): Promise<void> {
    return TokenService.revokeSession(sessionId, reason);
  }

  /** Suspending a user, resetting a password, "log out everywhere". */
  public static async revokeAllUserSessions(userId: string, reason: string, exceptSessionId?: string): Promise<void> {
    await TokenService.revokeAllForUser(userId, reason, exceptSessionId);
  }
}