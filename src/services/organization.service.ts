// path: src/services/organization.service.ts

import crypto from 'node:crypto';
import { and, asc, count, desc, eq, gt, ilike, isNull, lte, or } from 'drizzle-orm';
import { ASSIGNABLE_ROLES, canAssignRole, canManageMember, type AssignableRole } from '../auth/permissions.js';
import { resolveLimits } from '../config/plans.js';
import { db } from '../config/database.js';
import { StatusCodes } from '../constants/status-codes.js';
import {
  apiKeys,
  channels,
  organizationInvites,
  organizationMembers,
  organizations,
  users,
  type Organization,
  type OrgRole,
} from '../db/schema.js';
import type { Tx } from '../db/types.js';
import { ApiError } from '../utils/api.error.js';
import { isUniqueViolation } from '../utils/db-errors.js';
import { sha256Hex } from '../utils/crypto.util.js';
import { AuditService, type RequestMeta } from './audit.service.js';
import { AuthSessionService, type AuthUser } from './auth-session.service.js';
import { ChannelService } from './channel.service.js';
import { mailService, trySend } from './mail.service.js';
import { TokenService } from './token.service.js';

/* ============================================================================
 * Types
 * ========================================================================== */

/** The caller inside one organization (take it from req.user and req.org). */
export interface Actor {
  userId: string;
  role: OrgRole;
}

export interface Page {
  page?: number | undefined;
  limit?: number | undefined;
  search?: string | undefined;
}

export interface Paginated<T> {
  data: T[];
  meta: { total: number; page: number; limit: number; totalPages: number };
}

export interface MemberView {
  userId: string;
  fullName: string;
  email: string;
  role: OrgRole;
  status: 'ACTIVE' | 'SUSPENDED';
  joinedAt: Date;
}

export interface InviteView {
  id: string;
  email: string;
  role: OrgRole;
  status: 'PENDING' | 'ACCEPTED' | 'EXPIRED' | 'REVOKED';
  expiresAt: Date;
  createdAt: Date;
}

export interface InvitePreview {
  organizationName: string;
  inviterName: string | null;
  email: string;
  role: OrgRole;
  expiresAt: Date;
  /** Lets the page choose between "log in" and "create your account". */
  accountExists: boolean;
}

/* ============================================================================
 * Constants & helpers
 * ========================================================================== */

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_OWNED_ORGANIZATIONS = 5;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const escapeLike = (value: string): string => value.replace(/[\\%_]/g, '\\$&');

const conflict = (message: string, code: string): ApiError => new ApiError(StatusCodes.CONFLICT, message, code);

function generateSlug(name: string): string {
  const base =
    name
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'org';

  return `${base}-${crypto.randomBytes(3).toString('hex')}`;
}

function assertValidName(name: string): string {
  const clean = name.trim();
  if (clean.length < 2 || clean.length > 100) {
    throw ApiError.badRequest('Organization name must be between 2 and 100 characters.', 'INVALID_ORGANIZATION_NAME');
  }
  return clean;
}

/* ============================================================================
 * Service
 *
 * Rules enforced here (not only in the UI):
 *  - you can only manage or assign roles ranked strictly below your own
 *  - OWNER is never assigned or invited; it moves through transferOwnership
 *  - an organization always keeps at least one OWNER (checked under a row lock)
 *  - every change and its audit record commit together; caches are cleared after commit
 * ========================================================================== */

export class OrganizationService {
  /* ----------------------------- internal helpers ----------------------------- */

  /** Locks the organization row, which serialises seat/limit checks for that organization. */
  private static async lockOrganization(tx: Tx, organizationId: string) {
    const [org] = await tx
      .select({
        id: organizations.id,
        name: organizations.name,
        planType: organizations.planType,
        limitOverrides: organizations.limitOverrides,
        status: organizations.status,
      })
      .from(organizations)
      .where(and(eq(organizations.id, organizationId), isNull(organizations.deletedAt)))
      .for('update');

    if (!org) throw ApiError.notFound('Organization not found.', 'ORGANIZATION_NOT_FOUND');
    if (org.status !== 'ACTIVE') throw ApiError.forbidden('This organization is suspended.', 'ORGANIZATION_SUSPENDED');

    return org;
  }

  private static async countMembers(tx: Tx, organizationId: string): Promise<number> {
    const [row] = await tx
      .select({ value: count() })
      .from(organizationMembers)
      .where(eq(organizationMembers.organizationId, organizationId));
    return row?.value ?? 0;
  }

  private static async countPendingInvites(tx: Tx, organizationId: string): Promise<number> {
    const [row] = await tx
      .select({ value: count() })
      .from(organizationInvites)
      .where(
        and(
          eq(organizationInvites.organizationId, organizationId),
          eq(organizationInvites.status, 'PENDING'),
          gt(organizationInvites.expiresAt, new Date()),
        ),
      );
    return row?.value ?? 0;
  }

  /** Locks the OWNER rows so two owners leaving or demoting at once cannot orphan the organization. */
  private static async lockOwners(tx: Tx, organizationId: string): Promise<string[]> {
    const rows = await tx
      .select({ userId: organizationMembers.userId })
      .from(organizationMembers)
      .where(and(eq(organizationMembers.organizationId, organizationId), eq(organizationMembers.role, 'OWNER')))
      .for('update');
    return rows.map((row) => row.userId);
  }

  private static async lockMember(tx: Tx, organizationId: string, userId: string) {
    const [member] = await tx
      .select()
      .from(organizationMembers)
      .where(and(eq(organizationMembers.organizationId, organizationId), eq(organizationMembers.userId, userId)))
      .for('update');

    if (!member) throw ApiError.notFound('Member not found in this organization.', 'MEMBER_NOT_FOUND');
    return member;
  }

  /** A member leaving must not leave their API keys behind. */
  private static async revokeKeysOf(tx: Tx, organizationId: string, userId: string): Promise<void> {
    await tx
      .update(apiKeys)
      .set({ revokedAt: new Date() })
      .where(
        and(eq(apiKeys.organizationId, organizationId), eq(apiKeys.createdByUserId, userId), isNull(apiKeys.revokedAt)),
      );
  }

  /* ------------------------------ organizations ------------------------------ */

  /** Used by sign-up and by create(). Slug collisions retry inside a savepoint, so the outer transaction survives. */
  public static async createWithOwner(tx: Tx, input: { name: string; userId: string }): Promise<Organization> {
    const name = assertValidName(input.name);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        return await tx.transaction(async (savepoint) => {
          const [organization] = await savepoint
            .insert(organizations)
            .values({ name, slug: generateSlug(name), createdByUserId: input.userId })
            .returning();

          if (!organization) throw ApiError.internal('Could not create the organization.', 'ORGANIZATION_CREATE_FAILED');

          await savepoint
            .insert(organizationMembers)
            .values({ organizationId: organization.id, userId: input.userId, role: 'OWNER' });

          return organization;
        });
      } catch (error) {
        if (isUniqueViolation(error, 'organizations_slug_uq')) continue;
        throw error;
      }
    }

    throw ApiError.internal('Could not allocate a unique organization slug.', 'SLUG_ALLOCATION_FAILED');
  }

  /** An additional organization for an existing user (agencies, several businesses). */
  public static async create(user: AuthUser, name: string, meta: RequestMeta): Promise<Organization> {
    const [owned] = await db
      .select({ value: count() })
      .from(organizationMembers)
      .innerJoin(organizations, eq(organizations.id, organizationMembers.organizationId))
      .where(
        and(
          eq(organizationMembers.userId, user.userId),
          eq(organizationMembers.role, 'OWNER'),
          isNull(organizations.deletedAt),
        ),
      );

    if ((owned?.value ?? 0) >= MAX_OWNED_ORGANIZATIONS) {
      throw conflict('You have reached the maximum number of organizations.', 'ORGANIZATION_LIMIT_REACHED');
    }

    return db.transaction(async (tx) => {
      const organization = await this.createWithOwner(tx, { name, userId: user.userId });
      await AuditService.record(
        {
          organizationId: organization.id,
          actorUserId: user.userId,
          action: 'organization.created',
          targetType: 'organization',
          targetId: organization.id,
          meta,
        },
        tx,
      );
      return organization;
    });
  }

  public static async get(organizationId: string): Promise<Organization> {
    const [organization] = await db
      .select()
      .from(organizations)
      .where(and(eq(organizations.id, organizationId), isNull(organizations.deletedAt)))
      .limit(1);

    if (!organization) throw ApiError.notFound('Organization not found.', 'ORGANIZATION_NOT_FOUND');
    return organization;
  }

  public static async rename(organizationId: string, actor: Actor, name: string, meta: RequestMeta): Promise<Organization> {
    const clean = assertValidName(name);

    return db.transaction(async (tx) => {
      const [updated] = await tx
        .update(organizations)
        .set({ name: clean })
        .where(and(eq(organizations.id, organizationId), isNull(organizations.deletedAt)))
        .returning();

      if (!updated) throw ApiError.notFound('Organization not found.', 'ORGANIZATION_NOT_FOUND');

      await AuditService.record(
        { organizationId, actorUserId: actor.userId, action: 'organization.renamed', targetType: 'organization', targetId: organizationId, meta },
        tx,
      );
      return updated;
    });
  }

  /**
   * Soft delete. Channels are stopped and marked deleted, API keys revoked, pending invites revoked.
   * Rows stay for retention/audit; a scheduled purge job removes them later.
   */
  public static async deleteOrganization(organizationId: string, actor: Actor, meta: RequestMeta): Promise<void> {
    if (actor.role !== 'OWNER') throw ApiError.forbidden('Only an owner can delete the organization.', 'FORBIDDEN');

    const now = new Date();

    const channelIds = await db.transaction(async (tx) => {
      const [deleted] = await tx
        .update(organizations)
        .set({ deletedAt: now })
        .where(and(eq(organizations.id, organizationId), isNull(organizations.deletedAt)))
        .returning({ id: organizations.id });

      if (!deleted) throw ApiError.notFound('Organization not found.', 'ORGANIZATION_NOT_FOUND');

      const stopped = await tx
        .update(channels)
        .set({ deletedAt: now, status: 'STOPPED', statusReason: 'ORGANIZATION_DELETED' })
        .where(and(eq(channels.organizationId, organizationId), isNull(channels.deletedAt)))
        .returning({ id: channels.id });

      await tx.update(apiKeys).set({ revokedAt: now }).where(and(eq(apiKeys.organizationId, organizationId), isNull(apiKeys.revokedAt)));
      await tx
        .update(organizationInvites)
        .set({ status: 'REVOKED' })
        .where(and(eq(organizationInvites.organizationId, organizationId), eq(organizationInvites.status, 'PENDING')));

      await AuditService.record(
        { organizationId, actorUserId: actor.userId, action: 'organization.deleted', targetType: 'organization', targetId: organizationId, meta },
        tx,
      );

      return stopped.map((channel) => channel.id);
    });

    await AuthSessionService.invalidateOrganization(organizationId);
    await ChannelService.stopSessions(channelIds);
  }

  /* --------------------------------- members --------------------------------- */

  public static async listMembers(organizationId: string, query: Page): Promise<Paginated<MemberView>> {
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, Math.max(1, query.limit ?? 20));
    const pattern = query.search?.trim() ? `%${escapeLike(query.search.trim())}%` : null;

    const where = and(
      eq(organizationMembers.organizationId, organizationId),
      pattern ? or(ilike(users.fullName, pattern), ilike(users.email, pattern)) : undefined,
    );

    const [totals, rows] = await Promise.all([
      db
        .select({ value: count() })
        .from(organizationMembers)
        .innerJoin(users, eq(users.id, organizationMembers.userId))
        .where(where),
      db
        .select({
          userId: users.id,
          fullName: users.fullName,
          email: users.email,
          role: organizationMembers.role,
          status: organizationMembers.status,
          joinedAt: organizationMembers.joinedAt,
        })
        .from(organizationMembers)
        .innerJoin(users, eq(users.id, organizationMembers.userId))
        .where(where)
        .orderBy(asc(organizationMembers.joinedAt))
        .limit(limit)
        .offset((page - 1) * limit),
    ]);

    const total = totals[0]?.value ?? 0;
    return { data: rows, meta: { total, page, limit, totalPages: Math.ceil(total / limit) } };
  }

  public static async updateMemberRole(
    organizationId: string,
    actor: Actor,
    targetUserId: string,
    newRole: AssignableRole,
    meta: RequestMeta,
  ): Promise<{ userId: string; role: OrgRole }> {
    if (!(ASSIGNABLE_ROLES as readonly string[]).includes(newRole)) {
      throw ApiError.badRequest('Role must be ADMIN, MEMBER or VIEWER. Use ownership transfer for OWNER.', 'INVALID_ROLE');
    }
    if (actor.userId === targetUserId) {
      throw ApiError.badRequest('You cannot change your own role.', 'SELF_ROLE_CHANGE_PROHIBITED');
    }

    const result = await db.transaction(async (tx) => {
      const target = await this.lockMember(tx, organizationId, targetUserId);

      if (!canManageMember(actor.role, target.role) || !canAssignRole(actor.role, newRole)) {
        throw ApiError.forbidden('You cannot assign this role to this member.', 'FORBIDDEN');
      }

      await tx
        .update(organizationMembers)
        .set({ role: newRole })
        .where(eq(organizationMembers.id, target.id));

      await AuditService.record(
        {
          organizationId,
          actorUserId: actor.userId,
          action: 'member.role_changed',
          targetType: 'user',
          targetId: targetUserId,
          metadata: { from: target.role, to: newRole },
          meta,
        },
        tx,
      );

      return { userId: targetUserId, role: newRole as OrgRole };
    });

    await AuthSessionService.invalidateMembership(organizationId, targetUserId);
    return result;
  }

  /** Suspends or reactivates a member of THIS organization only. Account-level suspension is a platform action. */
  public static async setMemberStatus(
    organizationId: string,
    actor: Actor,
    targetUserId: string,
    status: 'ACTIVE' | 'SUSPENDED',
    meta: RequestMeta,
  ): Promise<void> {
    if (actor.userId === targetUserId) {
      throw ApiError.badRequest('You cannot change your own status.', 'SELF_STATUS_CHANGE_PROHIBITED');
    }

    await db.transaction(async (tx) => {
      const target = await this.lockMember(tx, organizationId, targetUserId);

      if (!canManageMember(actor.role, target.role)) {
        throw ApiError.forbidden('You cannot manage this member.', 'FORBIDDEN');
      }

      await tx.update(organizationMembers).set({ status }).where(eq(organizationMembers.id, target.id));
      await AuditService.record(
        {
          organizationId,
          actorUserId: actor.userId,
          action: status === 'SUSPENDED' ? 'member.suspended' : 'member.reactivated',
          targetType: 'user',
          targetId: targetUserId,
          meta,
        },
        tx,
      );
    });

    await AuthSessionService.invalidateMembership(organizationId, targetUserId);
  }

  public static async removeMember(organizationId: string, actor: Actor, targetUserId: string, meta: RequestMeta): Promise<void> {
    if (actor.userId === targetUserId) {
      throw ApiError.badRequest('Use "leave organization" to remove yourself.', 'USE_LEAVE');
    }

    await db.transaction(async (tx) => {
      const target = await this.lockMember(tx, organizationId, targetUserId);

      if (!canManageMember(actor.role, target.role)) {
        throw ApiError.forbidden('You cannot remove this member.', 'FORBIDDEN');
      }

      await tx.delete(organizationMembers).where(eq(organizationMembers.id, target.id));
      await this.revokeKeysOf(tx, organizationId, targetUserId);
      await AuditService.record(
        { organizationId, actorUserId: actor.userId, action: 'member.removed', targetType: 'user', targetId: targetUserId, meta },
        tx,
      );
    });

    await AuthSessionService.invalidateMembership(organizationId, targetUserId);
  }

  public static async leave(organizationId: string, user: AuthUser, meta: RequestMeta): Promise<void> {
    await db.transaction(async (tx) => {
      const owners = await this.lockOwners(tx, organizationId);
      const self = await this.lockMember(tx, organizationId, user.userId);

      if (self.role === 'OWNER' && owners.length <= 1) {
        throw conflict('Transfer ownership before leaving, or delete the organization.', 'LAST_OWNER');
      }

      await tx.delete(organizationMembers).where(eq(organizationMembers.id, self.id));
      await this.revokeKeysOf(tx, organizationId, user.userId);
      await AuditService.record(
        { organizationId, actorUserId: user.userId, action: 'member.left', targetType: 'user', targetId: user.userId, meta },
        tx,
      );
    });

    await AuthSessionService.invalidateMembership(organizationId, user.userId);
  }

  /** The current owner becomes ADMIN and the target becomes OWNER, in one atomic step. */
  public static async transferOwnership(organizationId: string, actor: Actor, targetUserId: string, meta: RequestMeta): Promise<void> {
    if (actor.role !== 'OWNER') throw ApiError.forbidden('Only an owner can transfer ownership.', 'FORBIDDEN');
    if (actor.userId === targetUserId) throw ApiError.badRequest('You already own this organization.', 'ALREADY_OWNER');

    await db.transaction(async (tx) => {
      await this.lockOwners(tx, organizationId);
      const self = await this.lockMember(tx, organizationId, actor.userId);
      const target = await this.lockMember(tx, organizationId, targetUserId);

      if (self.role !== 'OWNER') throw ApiError.forbidden('Only an owner can transfer ownership.', 'FORBIDDEN');
      if (target.status !== 'ACTIVE') throw conflict('The new owner must be an active member.', 'TARGET_NOT_ACTIVE');

      await tx.update(organizationMembers).set({ role: 'OWNER' }).where(eq(organizationMembers.id, target.id));
      await tx.update(organizationMembers).set({ role: 'ADMIN' }).where(eq(organizationMembers.id, self.id));

      await AuditService.record(
        { organizationId, actorUserId: actor.userId, action: 'organization.ownership_transferred', targetType: 'user', targetId: targetUserId, meta },
        tx,
      );
    });

    await Promise.all([
      AuthSessionService.invalidateMembership(organizationId, actor.userId),
      AuthSessionService.invalidateMembership(organizationId, targetUserId),
    ]);
  }

  /* -------------------------------- invitations -------------------------------- */

  /** Finds a pending, unexpired invite and locks it. Throws one generic error so tokens cannot be probed. */
  private static async lockUsableInvite(tx: Tx, token: string) {
    const [invite] = await tx
      .select()
      .from(organizationInvites)
      .where(eq(organizationInvites.tokenHash, sha256Hex(token)))
      .for('update');

    if (!invite || invite.status !== 'PENDING') {
      throw ApiError.badRequest('This invitation is invalid or no longer available.', 'INVITE_INVALID');
    }
    if (invite.expiresAt <= new Date()) {
      throw ApiError.badRequest('This invitation has expired. Ask for a new one.', 'INVITE_EXPIRED');
    }

    return invite;
  }

  public static async createInvite(
    organizationId: string,
    actor: Actor & { fullName: string },
    dto: { email: string; role: AssignableRole },
    meta: RequestMeta,
  ): Promise<InviteView> {
    const email = dto.email.trim().toLowerCase();

    if (email.length > 320 || !EMAIL_RE.test(email)) throw ApiError.badRequest('Invalid email address.', 'INVALID_EMAIL');
    if (!(ASSIGNABLE_ROLES as readonly string[]).includes(dto.role) || !canAssignRole(actor.role, dto.role)) {
      throw ApiError.forbidden('You cannot invite someone with this role.', 'FORBIDDEN');
    }

    const token = TokenService.generateOpaqueToken();
    const expiresAt = new Date(Date.now() + INVITE_TTL_MS);

    try {
      const { invite, organizationName } = await db.transaction(async (tx) => {
        const org = await this.lockOrganization(tx, organizationId);
        const limits = resolveLimits(org.planType, org.limitOverrides);

        const [alreadyMember] = await tx
          .select({ id: organizationMembers.id })
          .from(organizationMembers)
          .innerJoin(users, eq(users.id, organizationMembers.userId))
          .where(and(eq(organizationMembers.organizationId, organizationId), eq(users.email, email)))
          .limit(1);
        if (alreadyMember) throw conflict('This person is already a member.', 'ALREADY_MEMBER');

        // An expired invite must not block a new one (the unique index covers PENDING rows only).
        await tx
          .update(organizationInvites)
          .set({ status: 'EXPIRED' })
          .where(
            and(
              eq(organizationInvites.organizationId, organizationId),
              eq(organizationInvites.email, email),
              eq(organizationInvites.status, 'PENDING'),
              lte(organizationInvites.expiresAt, new Date()),
            ),
          );

        const seats = (await this.countMembers(tx, organizationId)) + (await this.countPendingInvites(tx, organizationId));
        if (seats >= limits.maxMembers) {
          throw ApiError.forbidden('Your plan has no free member seats.', 'PLAN_LIMIT_MEMBERS');
        }

        const [created] = await tx
          .insert(organizationInvites)
          .values({ organizationId, email, role: dto.role, tokenHash: token.tokenHash, invitedByUserId: actor.userId, expiresAt })
          .returning({
            id: organizationInvites.id,
            email: organizationInvites.email,
            role: organizationInvites.role,
            status: organizationInvites.status,
            expiresAt: organizationInvites.expiresAt,
            createdAt: organizationInvites.createdAt,
          });

        if (!created) throw ApiError.internal('Could not create the invitation.', 'INVITE_CREATE_FAILED');

        await AuditService.record(
          {
            organizationId,
            actorUserId: actor.userId,
            action: 'invite.created',
            targetType: 'invite',
            targetId: created.id,
            metadata: { role: dto.role },
            meta,
          },
          tx,
        );

        return { invite: created, organizationName: org.name };
      });

      await trySend(() =>
        mailService.sendOrganizationInvite(email, token.token, {
          organizationName,
          inviterName: actor.fullName,
          role: dto.role,
          expiresAt,
        }),
      );

      return invite;
    } catch (error) {
      if (isUniqueViolation(error, 'invites_pending_uq')) {
        throw conflict('This email already has a pending invitation. Resend or revoke it.', 'INVITE_ALREADY_PENDING');
      }
      throw error;
    }
  }

  public static async listInvites(organizationId: string): Promise<InviteView[]> {
    return db
      .select({
        id: organizationInvites.id,
        email: organizationInvites.email,
        role: organizationInvites.role,
        status: organizationInvites.status,
        expiresAt: organizationInvites.expiresAt,
        createdAt: organizationInvites.createdAt,
      })
      .from(organizationInvites)
      .where(eq(organizationInvites.organizationId, organizationId))
      .orderBy(desc(organizationInvites.createdAt))
      .limit(100);
  }

  public static async revokeInvite(organizationId: string, actor: Actor, inviteId: string, meta: RequestMeta): Promise<void> {
    await db.transaction(async (tx) => {
      const [invite] = await tx
        .select()
        .from(organizationInvites)
        .where(
          and(
            eq(organizationInvites.id, inviteId),
            eq(organizationInvites.organizationId, organizationId),
            eq(organizationInvites.status, 'PENDING'),
          ),
        )
        .for('update');

      if (!invite) throw ApiError.notFound('Invitation not found.', 'INVITE_NOT_FOUND');
      if (!canAssignRole(actor.role, invite.role)) throw ApiError.forbidden('You cannot revoke this invitation.', 'FORBIDDEN');

      await tx.update(organizationInvites).set({ status: 'REVOKED' }).where(eq(organizationInvites.id, invite.id));
      await AuditService.record(
        { organizationId, actorUserId: actor.userId, action: 'invite.revoked', targetType: 'invite', targetId: invite.id, meta },
        tx,
      );
    });
  }

  /** New token, fresh expiry. The old link stops working because only the new hash is stored. */
  public static async resendInvite(
    organizationId: string,
    actor: Actor & { fullName: string },
    inviteId: string,
    meta: RequestMeta,
  ): Promise<void> {
    const token = TokenService.generateOpaqueToken();
    const expiresAt = new Date(Date.now() + INVITE_TTL_MS);

    const sent = await db.transaction(async (tx) => {
      const org = await this.lockOrganization(tx, organizationId);

      const [invite] = await tx
        .select()
        .from(organizationInvites)
        .where(
          and(
            eq(organizationInvites.id, inviteId),
            eq(organizationInvites.organizationId, organizationId),
            eq(organizationInvites.status, 'PENDING'),
          ),
        )
        .for('update');

      if (!invite) throw ApiError.notFound('Invitation not found.', 'INVITE_NOT_FOUND');
      if (!canAssignRole(actor.role, invite.role)) throw ApiError.forbidden('You cannot resend this invitation.', 'FORBIDDEN');

      await tx
        .update(organizationInvites)
        .set({ tokenHash: token.tokenHash, expiresAt })
        .where(eq(organizationInvites.id, invite.id));

      await AuditService.record(
        { organizationId, actorUserId: actor.userId, action: 'invite.resent', targetType: 'invite', targetId: invite.id, meta },
        tx,
      );

      return { email: invite.email, role: invite.role, organizationName: org.name };
    });

    await trySend(() =>
      mailService.sendOrganizationInvite(sent.email, token.token, {
        organizationName: sent.organizationName,
        inviterName: actor.fullName,
        role: sent.role,
        expiresAt,
      }),
    );
  }

  /** Public (the token is the credential). Rate-limit the route. */
  public static async previewInvite(token: string): Promise<InvitePreview> {
    const [row] = await db
      .select({
        organizationName: organizations.name,
        inviterName: users.fullName,
        email: organizationInvites.email,
        role: organizationInvites.role,
        status: organizationInvites.status,
        expiresAt: organizationInvites.expiresAt,
      })
      .from(organizationInvites)
      .innerJoin(organizations, eq(organizations.id, organizationInvites.organizationId))
      .leftJoin(users, eq(users.id, organizationInvites.invitedByUserId))
      .where(and(eq(organizationInvites.tokenHash, sha256Hex(token)), isNull(organizations.deletedAt)))
      .limit(1);

    if (!row || row.status !== 'PENDING' || row.expiresAt <= new Date()) {
      throw ApiError.badRequest('This invitation is invalid or no longer available.', 'INVITE_INVALID');
    }

    const [account] = await db.select({ id: users.id }).from(users).where(eq(users.email, row.email)).limit(1);

    return {
      organizationName: row.organizationName,
      inviterName: row.inviterName,
      email: row.email,
      role: row.role,
      expiresAt: row.expiresAt,
      accountExists: Boolean(account),
    };
  }

  /**
   * Shared by "accept as an existing user" and "register through an invitation".
   * The invite is locked, must be addressed to this exact email, and is consumed atomically with
   * the membership insert. Cache invalidation is left to the caller, after commit.
   */
  public static async consumeInviteInTx(
    tx: Tx,
    input: { token: string; email: string; userId: string; meta?: RequestMeta | undefined },
  ): Promise<{ organizationId: string; role: OrgRole }> {
    const invite = await this.lockUsableInvite(tx, input.token);

    if (invite.email !== input.email.trim().toLowerCase()) {
      throw ApiError.forbidden('This invitation was sent to a different email address.', 'INVITE_EMAIL_MISMATCH');
    }

    const org = await this.lockOrganization(tx, invite.organizationId);
    const limits = resolveLimits(org.planType, org.limitOverrides);

    if ((await this.countMembers(tx, invite.organizationId)) >= limits.maxMembers) {
      throw ApiError.forbidden('This organization has no free member seats.', 'PLAN_LIMIT_MEMBERS');
    }

    const [accepted] = await tx
      .update(organizationInvites)
      .set({ status: 'ACCEPTED', acceptedAt: new Date(), acceptedByUserId: input.userId })
      .where(and(eq(organizationInvites.id, invite.id), eq(organizationInvites.status, 'PENDING')))
      .returning({ id: organizationInvites.id });

    if (!accepted) throw ApiError.badRequest('This invitation is invalid or no longer available.', 'INVITE_INVALID');

    // Already a member (for example added another way): keep the existing role, never downgrade or upgrade.
    const [inserted] = await tx
      .insert(organizationMembers)
      .values({
        organizationId: invite.organizationId,
        userId: input.userId,
        role: invite.role,
        invitedByUserId: invite.invitedByUserId,
      })
      .onConflictDoNothing()
      .returning({ role: organizationMembers.role });

    await AuditService.record(
      {
        organizationId: invite.organizationId,
        actorUserId: input.userId,
        action: 'member.joined',
        targetType: 'user',
        targetId: input.userId,
        metadata: { via: 'invite', inviteId: invite.id },
        meta: input.meta,
      },
      tx,
    );

    return { organizationId: invite.organizationId, role: inserted?.role ?? invite.role };
  }

  /** An existing, logged-in user accepts. The invite must be addressed to their email. */
  public static async acceptInvite(user: AuthUser, token: string, meta: RequestMeta): Promise<{ organizationId: string; role: OrgRole }> {
    const joined = await db.transaction((tx) =>
      this.consumeInviteInTx(tx, { token, email: user.email, userId: user.userId, meta }),
    );

    await AuthSessionService.invalidateMembership(joined.organizationId, user.userId);
    return joined;
  }
}