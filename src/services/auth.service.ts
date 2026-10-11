// path: src/services/auth.service.ts

import { and, asc, eq, isNull } from 'drizzle-orm';
import { db } from '../config/database.js';
import type { PlanType } from '../config/plans.js';
import { redis } from '../config/redis.js';
import { StatusCodes } from '../constants/status-codes.js';
import {
  organizationMembers,
  organizations,
  users,
  verificationTokens,
  type AccountStatus,
  type OrgRole,
  type OrganizationStatus,
  type PlatformRole,
} from '../db/schema.js';
import type { DbExecutor } from '../db/types.js';
import { ApiError } from '../utils/api.error.js';
import { sha256Hex } from '../utils/crypto.util.js';
import { isUniqueViolation } from '../utils/db-errors.js';
import { AuditService, type RequestMeta } from './audit.service.js';
import { AuthSessionService, type AuthUser } from './auth-session.service.js';
import { mailService, trySend } from './mail.service.js';
import { OrganizationService } from './organization.service.js';
import { PasswordService, validatePasswordPolicy } from './password.service.js';
import { TokenService } from './token.service.js';

/* ============================================================================
 * Types
 * ========================================================================== */

export interface RegisterDTO {
  fullName: string;
  email: string;
  password: string;
  /** Required for a normal sign-up (creates the user's organization). Ignored when inviteToken is set. */
  businessName?: string | undefined;
  /** Sign-up through an invitation: joins that organization instead of creating one. */
  inviteToken?: string | undefined;
}

export interface LoginDTO {
  email: string;
  password: string;
}

export interface UpdateProfileDTO {
  fullName?: string | undefined;
  phoneNumber?: string | null | undefined;
}

export interface ChangePasswordDTO {
  currentPassword: string;
  newPassword: string;
}

export interface PublicUser {
  id: string;
  email: string;
  fullName: string;
  platformRole: PlatformRole;
  status: AccountStatus;
}

export interface UserOrganization {
  id: string;
  name: string;
  slug: string;
  planType: PlanType;
  status: OrganizationStatus;
  role: OrgRole;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

export interface AuthResult {
  user: PublicUser;
  organizations: UserOrganization[];
  tokens: AuthTokens;
}

export interface RegisterResult {
  message: string;
  user: PublicUser;
  organizationId: string | null;
  /** Present only for invitation sign-ups, where the invite already proved email ownership. */
  tokens: AuthTokens | null;
}

/* ============================================================================
 * Constants & helpers
 * ========================================================================== */

const VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;
const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000;

const LOGIN_MAX_FAILURES = 5;
const LOGIN_WINDOW_SECONDS = 15 * 60;
const EMAIL_COOLDOWN_SECONDS = 60;

const PUBLIC_USER = {
  id: users.id,
  email: users.email,
  fullName: users.fullName,
  platformRole: users.platformRole,
  status: users.status,
} as const;

const GENERIC_EMAIL_SENT = 'If the address is eligible, an email has been sent.';

const normalizeEmail = (email: string): string => email.trim().toLowerCase();
const failureKey = (email: string): string => `auth:login:fail:${sha256Hex(email)}`;
const cooldownKey = (kind: string, email: string): string => `auth:cooldown:${kind}:${sha256Hex(email)}`;

const toTokens = (pair: { accessToken: string; refreshToken: string }): AuthTokens => ({
  accessToken: pair.accessToken,
  refreshToken: pair.refreshToken,
});

/* ============================================================================
 * Service
 * ========================================================================== */

export class AuthService {
  /* ---------------------------- private helpers ---------------------------- */

  private static async loadOrganizations(userId: string): Promise<UserOrganization[]> {
    return db
      .select({
        id: organizations.id,
        name: organizations.name,
        slug: organizations.slug,
        planType: organizations.planType,
        status: organizations.status,
        role: organizationMembers.role,
      })
      .from(organizationMembers)
      .innerJoin(organizations, eq(organizations.id, organizationMembers.organizationId))
      .where(
        and(
          eq(organizationMembers.userId, userId),
          eq(organizationMembers.status, 'ACTIVE'),
          isNull(organizations.deletedAt),
        ),
      )
      .orderBy(asc(organizationMembers.joinedAt));
  }

  /** Replaces any unused token of the same purpose with a fresh one. Returns the raw token to email. */
  private static async issueToken(
    executor: DbExecutor,
    userId: string,
    purpose: 'EMAIL_VERIFICATION' | 'PASSWORD_RESET',
    ttlMs: number,
  ): Promise<string> {
    const now = new Date();

    await executor
      .update(verificationTokens)
      .set({ consumedAt: now })
      .where(
        and(
          eq(verificationTokens.userId, userId),
          eq(verificationTokens.purpose, purpose),
          isNull(verificationTokens.consumedAt),
        ),
      );

    const { token, tokenHash } = TokenService.generateOpaqueToken();

    await executor.insert(verificationTokens).values({
      userId,
      purpose,
      tokenHash,
      expiresAt: new Date(now.getTime() + ttlMs),
    });

    return token;
  }

  /** Atomic single use: of two simultaneous requests with the same token, only one gets a user id back. */
  private static async consumeToken(
    executor: DbExecutor,
    token: string,
    purpose: 'EMAIL_VERIFICATION' | 'PASSWORD_RESET',
  ): Promise<string | null> {
    const now = new Date();

    const [row] = await executor
      .update(verificationTokens)
      .set({ consumedAt: now })
      .where(
        and(
          eq(verificationTokens.tokenHash, sha256Hex(token)),
          eq(verificationTokens.purpose, purpose),
          isNull(verificationTokens.consumedAt),
        ),
      )
      .returning({ userId: verificationTokens.userId, expiresAt: verificationTokens.expiresAt });

    return row && row.expiresAt > now ? row.userId : null;
  }

  private static async assertNotThrottled(email: string): Promise<void> {
    const failures = Number((await redis.get(failureKey(email))) ?? 0);

    if (failures >= LOGIN_MAX_FAILURES) {
      throw new ApiError(
        StatusCodes.TOO_MANY_REQUESTS,
        'Too many failed attempts. Try again later.',
        'TOO_MANY_ATTEMPTS',
      );
    }
  }

  private static async registerFailure(email: string): Promise<void> {
    const key = failureKey(email);
    const failures = await redis.incr(key);
    if (failures === 1) await redis.expire(key, LOGIN_WINDOW_SECONDS);
  }

  /** True when the caller may proceed; false while a previous email to this address is still cooling down. */
  private static async acquireCooldown(kind: string, email: string): Promise<boolean> {
    const result = await redis.set(cooldownKey(kind, email), '1', 'EX', EMAIL_COOLDOWN_SECONDS, 'NX');
    return result === 'OK';
  }

  /* -------------------------------- sign-up -------------------------------- */

  /**
   * Identifier-first UX helper. It reveals whether an email is registered, so the route MUST sit
   * behind a strict per-IP rate limit.
   */
  public static async checkEmail(email: string): Promise<{ exists: boolean; action: 'LOGIN' | 'REGISTER' }> {
    const [row] = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.email, normalizeEmail(email)), isNull(users.deletedAt)))
      .limit(1);

    return { exists: Boolean(row), action: row ? 'LOGIN' : 'REGISTER' };
  }

  public static async register(dto: RegisterDTO, meta: RequestMeta): Promise<RegisterResult> {
    const email = normalizeEmail(dto.email);
    const fullName = dto.fullName.trim();
    const inviteToken = dto.inviteToken?.trim() || null;
    const businessName = dto.businessName?.trim() || null;

    if (fullName.length < 2 || fullName.length > 255) {
      throw ApiError.badRequest('Full name must be between 2 and 255 characters.', 'INVALID_NAME');
    }
    if (!inviteToken && (!businessName || businessName.length < 2 || businessName.length > 100)) {
      throw ApiError.badRequest('Business name must be between 2 and 100 characters.', 'INVALID_BUSINESS_NAME');
    }

    validatePasswordPolicy(dto.password, email);
    const passwordHash = await PasswordService.hash(dto.password);

    try {
      const created = await db.transaction(async (tx) => {
        const invited = inviteToken !== null;

        const [user] = await tx
          .insert(users)
          .values({
            email,
            passwordHash,
            fullName,
            // An invitation was delivered to this very address, so it proves ownership.
            status: invited ? 'ACTIVE' : 'PENDING_VERIFICATION',
            emailVerifiedAt: invited ? new Date() : null,
          })
          .returning(PUBLIC_USER);

        if (!user) throw ApiError.internal('Could not create the account.', 'USER_CREATE_FAILED');

        if (inviteToken) {
          const joined = await OrganizationService.consumeInviteInTx(tx, { token: inviteToken, email, userId: user.id });
          const pair = await TokenService.createSession(user.id, meta, tx);

          await AuditService.record(
            {
              actorUserId: user.id,
              organizationId: joined.organizationId,
              action: 'auth.registered_via_invite',
              targetType: 'user',
              targetId: user.id,
              meta,
            },
            tx,
          );

          return { user, organizationId: joined.organizationId, tokens: toTokens(pair), verificationToken: null };
        }

        const organization = await OrganizationService.createWithOwner(tx, {
          name: businessName as string, // validated above: non-null whenever there is no invite
          userId: user.id,
        });
        const verificationToken = await this.issueToken(tx, user.id, 'EMAIL_VERIFICATION', VERIFICATION_TTL_MS);

        await AuditService.record(
          {
            actorUserId: user.id,
            organizationId: organization.id,
            action: 'auth.registered',
            targetType: 'user',
            targetId: user.id,
            meta,
          },
          tx,
        );

        return { user, organizationId: organization.id, tokens: null, verificationToken };
      });

      if (created.verificationToken) {
        const token = created.verificationToken;
        await trySend(() => mailService.sendEmailVerification(email, token));
      }

      return {
        message: created.tokens
          ? 'Registration successful.'
          : 'Registration successful. Please verify your email address to activate your account.',
        user: created.user,
        organizationId: created.organizationId,
        tokens: created.tokens,
      };
    } catch (error) {
      if (isUniqueViolation(error, 'users_email_uq')) {
        throw new ApiError(StatusCodes.CONFLICT, 'An account with this email address already exists.', 'EMAIL_EXISTS');
      }
      throw error;
    }
  }

  /** The emailed link is the proof of ownership: no token, no verification. */
  public static async verifyEmail(token: string, meta: RequestMeta): Promise<AuthResult> {
    const { user, pair } = await db.transaction(async (tx) => {
      const userId = await this.consumeToken(tx, token, 'EMAIL_VERIFICATION');
      if (!userId) {
        throw ApiError.badRequest('The verification link is invalid or has expired.', 'INVALID_VERIFICATION_TOKEN');
      }

      await tx
        .update(users)
        .set({ emailVerifiedAt: new Date(), status: 'ACTIVE' })
        .where(and(eq(users.id, userId), eq(users.status, 'PENDING_VERIFICATION')));

      const [row] = await tx
        .select(PUBLIC_USER)
        .from(users)
        .where(and(eq(users.id, userId), isNull(users.deletedAt)))
        .limit(1);

      if (!row || row.status !== 'ACTIVE') {
        throw ApiError.forbidden('This account is not available.', 'ACCOUNT_UNAVAILABLE');
      }

      const session = await TokenService.createSession(row.id, meta, tx);
      await AuditService.record(
        { actorUserId: row.id, action: 'auth.email_verified', targetType: 'user', targetId: row.id, meta },
        tx,
      );

      return { user: row, pair: session };
    });

    await AuthSessionService.invalidateUser(user.id);

    return { user, organizations: await this.loadOrganizations(user.id), tokens: toTokens(pair) };
  }

  /** Same response whether or not the address exists or is pending, so it cannot be used to probe. */
  public static async resendVerification(rawEmail: string): Promise<{ message: string }> {
    const email = normalizeEmail(rawEmail);

    if (await this.acquireCooldown('verify', email)) {
      const [user] = await db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.email, email), eq(users.status, 'PENDING_VERIFICATION'), isNull(users.deletedAt)))
        .limit(1);

      if (user) {
        const token = await this.issueToken(db, user.id, 'EMAIL_VERIFICATION', VERIFICATION_TTL_MS);
        await trySend(() => mailService.sendEmailVerification(email, token));
      }
    }

    return { message: GENERIC_EMAIL_SENT };
  }

  /* --------------------------------- login --------------------------------- */

  public static async login(dto: LoginDTO, meta: RequestMeta): Promise<AuthResult> {
    const email = normalizeEmail(dto.email);
    await this.assertNotThrottled(email);

    const [user] = await db
      .select({ ...PUBLIC_USER, passwordHash: users.passwordHash, emailVerifiedAt: users.emailVerifiedAt })
      .from(users)
      .where(and(eq(users.email, email), isNull(users.deletedAt)))
      .limit(1);

    // Always runs a hash comparison, even for unknown emails, so timing does not reveal accounts.
    const { valid, needsRehash } = await PasswordService.verify(user?.passwordHash, dto.password);

    if (!user || !valid) {
      await this.registerFailure(email);
      await AuditService.recordBestEffort({
        actorUserId: user?.id ?? null,
        action: 'auth.login_failed',
        targetType: 'user',
        targetId: user?.id,
        meta,
      });
      throw ApiError.unauthorized('Invalid email or password credentials.', 'INVALID_CREDENTIALS');
    }

    // Status is checked only AFTER the password, so these answers are never given to a stranger.
    if (user.status === 'SUSPENDED') {
      throw ApiError.forbidden('Your account has been suspended. Please contact support.', 'ACCOUNT_SUSPENDED');
    }
    if (user.status !== 'ACTIVE' || !user.emailVerifiedAt) {
      throw ApiError.forbidden('Email address is not verified.', 'EMAIL_NOT_VERIFIED');
    }

    await redis.del(failureKey(email));

    const upgradedHash = needsRehash ? await PasswordService.hash(dto.password) : null;
    const pair = await db.transaction(async (tx) => {
      await tx
        .update(users)
        .set({ lastLoginAt: new Date(), ...(upgradedHash ? { passwordHash: upgradedHash } : {}) })
        .where(eq(users.id, user.id));

      const session = await TokenService.createSession(user.id, meta, tx);
      await AuditService.record({ actorUserId: user.id, action: 'auth.login', targetType: 'user', targetId: user.id, meta }, tx);

      return session;
    });

    const { passwordHash: _hash, emailVerifiedAt: _verifiedAt, ...publicUser } = user;

    return { user: publicUser, organizations: await this.loadOrganizations(user.id), tokens: toTokens(pair) };
  }

  /** Rotates the refresh token. An account suspended meanwhile cannot obtain new tokens. */
  public static async refresh(refreshToken: string): Promise<AuthTokens> {
    const rotated = await TokenService.rotate(refreshToken);
    const { userId } = TokenService.verifyAccessToken(rotated.accessToken);

    const user = await AuthSessionService.getUserContext(userId);
    if (!user) {
      await AuthSessionService.revokeSession(rotated.sessionId, 'ACCOUNT_UNAVAILABLE');
      throw ApiError.unauthorized('Account is unavailable', 'ACCOUNT_UNAVAILABLE');
    }

    return toTokens(rotated);
  }

  /** Ends this device only. */
  public static async logout(user: AuthUser, meta: RequestMeta): Promise<void> {
    await AuthSessionService.revokeSession(user.sessionId, 'LOGOUT');
    await AuditService.recordBestEffort({ actorUserId: user.userId, action: 'auth.logout', meta });
  }

  /** Ends every device. */
  public static async logoutAll(user: AuthUser, meta: RequestMeta): Promise<void> {
    await AuthSessionService.revokeAllUserSessions(user.userId, 'LOGOUT_ALL');
    await AuditService.recordBestEffort({ actorUserId: user.userId, action: 'auth.logout_all', meta });
  }

  /* ------------------------------ devices ------------------------------ */

  public static async listSessions(user: AuthUser) {
    const sessions = await TokenService.listActiveSessions(user.userId);
    return sessions.map((session) => ({ ...session, isCurrent: session.id === user.sessionId }));
  }

  /** Users can end only their own sessions. */
  public static async revokeOwnSession(user: AuthUser, sessionId: string, meta: RequestMeta): Promise<void> {
    const owned = (await TokenService.listActiveSessions(user.userId)).some((session) => session.id === sessionId);
    if (!owned) throw ApiError.notFound('Session not found.', 'SESSION_NOT_FOUND');

    await AuthSessionService.revokeSession(sessionId, 'REVOKED_BY_USER');
    await AuditService.recordBestEffort({
      actorUserId: user.userId,
      action: 'auth.session_revoked',
      targetType: 'auth_session',
      targetId: sessionId,
      meta,
    });
  }

  /* ------------------------------- profile ------------------------------- */

  public static async getProfile(userId: string): Promise<{ user: PublicUser; phoneNumber: string | null; organizations: UserOrganization[] }> {
    const [row] = await db
      .select({ ...PUBLIC_USER, phoneNumber: users.phoneNumber })
      .from(users)
      .where(and(eq(users.id, userId), isNull(users.deletedAt)))
      .limit(1);

    if (!row) throw ApiError.notFound('User profile not found.', 'USER_NOT_FOUND');

    const { phoneNumber, ...user } = row;
    return { user, phoneNumber, organizations: await this.loadOrganizations(userId) };
  }

  public static async updateProfile(userId: string, dto: UpdateProfileDTO): Promise<PublicUser> {
    const patch: { fullName?: string; phoneNumber?: string | null } = {};

    if (dto.fullName !== undefined) {
      const fullName = dto.fullName.trim();
      if (fullName.length < 2 || fullName.length > 255) {
        throw ApiError.badRequest('Full name must be between 2 and 255 characters.', 'INVALID_NAME');
      }
      patch.fullName = fullName;
    }
    if (dto.phoneNumber !== undefined) {
      patch.phoneNumber = dto.phoneNumber === null ? null : dto.phoneNumber.replace(/[^\d+]/g, '').slice(0, 32) || null;
    }

    if (Object.keys(patch).length === 0) {
      throw ApiError.badRequest('Nothing to update.', 'EMPTY_UPDATE');
    }

    const [updated] = await db
      .update(users)
      .set(patch)
      .where(and(eq(users.id, userId), isNull(users.deletedAt)))
      .returning(PUBLIC_USER);

    if (!updated) throw ApiError.notFound('User profile not found.', 'USER_NOT_FOUND');

    await AuthSessionService.invalidateUser(userId);
    return updated;
  }

  /* ------------------------------ passwords ------------------------------ */

  /** Keeps the current device signed in and ends every other one. */
  public static async changePassword(user: AuthUser, dto: ChangePasswordDTO, meta: RequestMeta): Promise<void> {
    const [row] = await db.select({ passwordHash: users.passwordHash }).from(users).where(eq(users.id, user.userId)).limit(1);

    const { valid } = await PasswordService.verify(row?.passwordHash, dto.currentPassword);
    if (!valid) throw ApiError.unauthorized('Current password provided is incorrect.', 'INVALID_CURRENT_PASSWORD');

    validatePasswordPolicy(dto.newPassword, user.email);
    const passwordHash = await PasswordService.hash(dto.newPassword);

    await db.transaction(async (tx) => {
      await tx.update(users).set({ passwordHash, passwordChangedAt: new Date() }).where(eq(users.id, user.userId));
      await AuditService.record(
        { actorUserId: user.userId, action: 'auth.password_changed', targetType: 'user', targetId: user.userId, meta },
        tx,
      );
    });

    await AuthSessionService.revokeAllUserSessions(user.userId, 'PASSWORD_CHANGED', user.sessionId);
  }

  public static async requestPasswordReset(rawEmail: string): Promise<{ message: string }> {
    const email = normalizeEmail(rawEmail);

    if (await this.acquireCooldown('reset', email)) {
      const [user] = await db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.email, email), eq(users.status, 'ACTIVE'), isNull(users.deletedAt)))
        .limit(1);

      if (user) {
        const token = await this.issueToken(db, user.id, 'PASSWORD_RESET', PASSWORD_RESET_TTL_MS);
        await trySend(() => mailService.sendPasswordReset(email, token));
      }
    }

    return { message: GENERIC_EMAIL_SENT };
  }

  public static async resetPassword(token: string, newPassword: string, meta: RequestMeta): Promise<void> {
    const userId = await db.transaction(async (tx) => {
      const id = await this.consumeToken(tx, token, 'PASSWORD_RESET');
      if (!id) throw ApiError.badRequest('The reset link is invalid or has expired.', 'INVALID_RESET_TOKEN');

      const [row] = await tx.select({ email: users.email }).from(users).where(eq(users.id, id)).limit(1);
      if (!row) throw ApiError.badRequest('The reset link is invalid or has expired.', 'INVALID_RESET_TOKEN');

      validatePasswordPolicy(newPassword, row.email);

      await tx
        .update(users)
        .set({ passwordHash: await PasswordService.hash(newPassword), passwordChangedAt: new Date() })
        .where(eq(users.id, id));

      await AuditService.record(
        { actorUserId: id, action: 'auth.password_reset', targetType: 'user', targetId: id, meta },
        tx,
      );

      return id;
    });

    await AuthSessionService.revokeAllUserSessions(userId, 'PASSWORD_RESET');
  }
}