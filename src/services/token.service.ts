// path: src/services/token.service.ts

import jwt from 'jsonwebtoken';
import { and, eq, gt, isNull, ne, sql } from 'drizzle-orm';
import { db } from '../config/database.js';
import { env } from '../config/env.js';
import { authSessions } from '../db/schema.js';
import type { DbExecutor } from '../db/types.js';
import { ApiError } from '../utils/api.error.js';
import { decryptJson, deriveKey, encryptJson, randomToken, safeEqual, sha256Hex } from '../utils/crypto.util.js';
import { CacheService } from './cache.service.js';
import { appEvents } from './session-events.js';

/* ============================================================================
 * Configuration (fails at startup instead of falling back to a known secret)
 * ========================================================================== */

const ACCESS_SECRET = (() => {
  const secret = env.JWT_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('JWT_SECRET must be set and at least 32 characters. Generate one: openssl rand -base64 48');
  }
  return secret;
})();

const ISSUER = 'nexius';
const AUDIENCE = 'nexius-api';
const ACCESS_TTL_SECONDS = 15 * 60;
const SESSION_ABSOLUTE_DAYS = 30; // hard limit, whatever the activity
const SESSION_IDLE_DAYS = 7; // unused for this long -> must log in again
const REFRESH_GRACE_SECONDS = 30; // concurrent tabs may replay the same refresh token inside this window
const DAY_MS = 86_400_000;

const REPLAY_KEY = deriveKey(ACCESS_SECRET, 'refresh-replay-v1');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const invalidRefresh = () => ApiError.unauthorized('Invalid or expired refresh token', 'INVALID_REFRESH_TOKEN');

/* ============================================================================
 * Types
 * ========================================================================== */

export interface AccessClaims {
  userId: string;
  sessionId: string;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  sessionId: string;
}

export interface RotatedTokens extends TokenPair {
  gracePeriodActive: boolean;
}

export interface SessionClientInfo {
  ipAddress?: string | undefined;
  userAgent?: string | undefined;
}

/* ============================================================================
 * Service
 *
 * Access token : short-lived JWT {sub: userId, sid: sessionId}. No role or organization inside:
 *                those are resolved per request, so they can never be stale or forged.
 * Refresh token: opaque "<sessionId>.<secret>". Only SHA-256(secret) is stored. One row per
 *                device in auth_sessions, so logout / revoke work per device.
 * ========================================================================== */

export class TokenService {
  /* ---------------------------- access token ---------------------------- */

  public static signAccessToken(claims: AccessClaims): string {
    return jwt.sign({ sid: claims.sessionId }, ACCESS_SECRET, {
      algorithm: 'HS256',
      expiresIn: ACCESS_TTL_SECONDS,
      subject: claims.userId,
      issuer: ISSUER,
      audience: AUDIENCE,
    });
  }

  public static verifyAccessToken(token: string): AccessClaims {
    try {
      const payload = jwt.verify(token, ACCESS_SECRET, {
        algorithms: ['HS256'], // pinned: rejects "alg: none" and algorithm confusion
        issuer: ISSUER,
        audience: AUDIENCE,
      });

      if (typeof payload === 'string' || typeof payload.sub !== 'string' || typeof payload.sid !== 'string') {
        throw new Error('malformed claims');
      }

      return { userId: payload.sub, sessionId: payload.sid };
    } catch {
      throw ApiError.unauthorized('Invalid or expired access token', 'INVALID_ACCESS_TOKEN');
    }
  }

  /* ----------------------------- sessions ------------------------------ */

  /** Creates a device session (a login). Pass `tx` to make it part of a transaction. */
  public static async createSession(
    userId: string,
    client: SessionClientInfo,
    executor: DbExecutor = db,
  ): Promise<TokenPair> {
    const sessionId = crypto.randomUUID();
    const secret = randomToken(32);

    await executor.insert(authSessions).values({
      id: sessionId,
      userId,
      refreshTokenHash: sha256Hex(secret),
      ipAddress: client.ipAddress ?? null,
      userAgent: client.userAgent ?? null,
      expiresAt: new Date(Date.now() + SESSION_ABSOLUTE_DAYS * DAY_MS),
    });

    return {
      sessionId,
      accessToken: this.signAccessToken({ userId, sessionId }),
      refreshToken: `${sessionId}.${secret}`,
    };
  }

  /**
   * Rotation with reuse detection.
   *
   * The compare-and-swap UPDATE is atomic: of N concurrent requests holding the same refresh
   * token, exactly one wins and rotates. The others either replay the winner's result (inside the
   * grace window, from an encrypted Redis entry) or, outside it, are treated as token theft and
   * the whole session is revoked.
   */
  public static async rotate(refreshToken: string): Promise<RotatedTokens> {
    const { sid, secretHash } = this.parseRefreshToken(refreshToken);
    const now = new Date();
    const idleCutoff = new Date(now.getTime() - SESSION_IDLE_DAYS * DAY_MS);
    const newSecret = randomToken(32);

    const [won] = await db 
      .update(authSessions)
      .set({
        previousRefreshTokenHash: sql`${authSessions.refreshTokenHash}`,
        refreshTokenHash: sha256Hex(newSecret),
        rotatedAt: now,
        lastUsedAt: now,
      })
      .where(
        and(
          eq(authSessions.id, sid),
          eq(authSessions.refreshTokenHash, secretHash),
          isNull(authSessions.revokedAt),
          gt(authSessions.expiresAt, now),
          gt(authSessions.lastUsedAt, idleCutoff),
        ),
      )
      .returning({ userId: authSessions.userId });

    if (won) {
      const pair: TokenPair = {
        sessionId: sid,
        accessToken: this.signAccessToken({ userId: won.userId, sessionId: sid }),
        refreshToken: `${sid}.${newSecret}`,
      };

      await CacheService.set(this.replayKey(sid, secretHash), encryptJson(pair, REPLAY_KEY), REFRESH_GRACE_SECONDS);
      return { ...pair, gracePeriodActive: false };
    }

    return this.handleLostRotation(sid, secretHash, now);
  }

  private static async handleLostRotation(sid: string, secretHash: string, now: Date): Promise<RotatedTokens> {
    const [session] = await db.select().from(authSessions).where(eq(authSessions.id, sid)).limit(1);

    if (!session || session.revokedAt || session.expiresAt <= now) throw invalidRefresh();

    const isPrevious = session.previousRefreshTokenHash !== null && safeEqual(session.previousRefreshTokenHash, secretHash);
    if (!isPrevious) throw invalidRefresh();

    const insideGrace = session.rotatedAt !== null && now.getTime() - session.rotatedAt.getTime() <= REFRESH_GRACE_SECONDS * 1000;

    if (insideGrace) {
      // The winner may not have written the replay entry yet. Give it a moment.
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const cached = await CacheService.get<string>(this.replayKey(sid, secretHash));
        const pair = cached ? decryptJson<TokenPair>(cached, REPLAY_KEY) : null;
        if (pair) return { ...pair, gracePeriodActive: true };
        await new Promise((resolve) => setTimeout(resolve, 150));
      }

      // Not proof of theft, so do not revoke. The client can simply retry.
      throw ApiError.unauthorized('Refresh is already in progress. Retry shortly.', 'REFRESH_RETRY');
    }

    // An already-rotated token came back after the grace window: assume it was stolen.
    await this.revokeSession(sid, 'REFRESH_TOKEN_REUSE');
    throw ApiError.unauthorized(
      'Refresh token reuse detected. Please log in again.',
      'TOKEN_REUSE_DETECTED',
    );
  }

  private static parseRefreshToken(token: string): { sid: string; secretHash: string } {
    const parts = token.split('.');
    const [sid, secret] = parts;

    if (parts.length !== 2 || !sid || !secret || !UUID_RE.test(sid) || secret.length < 20 || secret.length > 128) {
      throw invalidRefresh();
    }

    return { sid, secretHash: sha256Hex(secret) };
  }

  private static replayKey(sid: string, secretHash: string): string {
    return `auth:refresh-replay:${sid}:${secretHash.slice(0, 32)}`;
  }

  /* ---------------------------- revocation ----------------------------- */

  /** Revoked sessions are put on a short Redis denylist so their access token dies immediately. */
  public static async denySession(sessionId: string): Promise<void> {
    await CacheService.set(`auth:revoked:${sessionId}`, 1, ACCESS_TTL_SECONDS + 60);
  }

  public static async isSessionDenied(sessionId: string): Promise<boolean> {
    return Boolean(await CacheService.get(`auth:revoked:${sessionId}`));
  }

  public static async revokeSession(sessionId: string, reason: string, executor: DbExecutor = db): Promise<void> {
    const [row] = await executor
      .update(authSessions)
      .set({ revokedAt: new Date(), revokedReason: reason })
      .where(and(eq(authSessions.id, sessionId), isNull(authSessions.revokedAt)))
      .returning({ userId: authSessions.userId });

    await this.denySession(sessionId);
    if (row) appEvents.emitSessionRevoked({ sessionId, userId: row.userId });
  }

  /** Revokes every active session of a user, optionally keeping the current one. Returns the revoked ids. */
  public static async revokeAllForUser(userId: string, reason: string, exceptSessionId?: string): Promise<string[]> {
    const rows = await db
      .update(authSessions)
      .set({ revokedAt: new Date(), revokedReason: reason })
      .where(
        and(
          eq(authSessions.userId, userId),
          isNull(authSessions.revokedAt),
          exceptSessionId ? ne(authSessions.id, exceptSessionId) : undefined,
        ),
      )
      .returning({ id: authSessions.id });

    await Promise.all(rows.map((row) => this.denySession(row.id)));
    rows.forEach((row) => appEvents.emitSessionRevoked({ sessionId: row.id, userId }));

    return rows.map((row) => row.id);
  }

  public static async listActiveSessions(userId: string) {
    return db
      .select({
        id: authSessions.id,
        ipAddress: authSessions.ipAddress,
        userAgent: authSessions.userAgent,
        lastUsedAt: authSessions.lastUsedAt,
        createdAt: authSessions.createdAt,
      })
      .from(authSessions)
      .where(and(eq(authSessions.userId, userId), isNull(authSessions.revokedAt), gt(authSessions.expiresAt, new Date())));
  }

  /* ------------------------ one-time tokens, API keys ------------------------ */

  /** For email verification, password reset and invitations. Store `tokenHash`, send `token`. */
  public static generateOpaqueToken(): { token: string; tokenHash: string } {
    const token = randomToken(32);
    return { token, tokenHash: sha256Hex(token) };
  }

  public static generateApiKey(prefix = 'nx'): { rawKey: string; keyHash: string; displayPrefix: string } {
    const rawKey = `${prefix}_${randomToken(32)}`;
    return { rawKey, keyHash: sha256Hex(rawKey), displayPrefix: rawKey.slice(0, 12) };
  }

  /** Look keys up by hash (unique index); this is only for the extra constant-time confirmation. */
  public static verifyApiKeyHash(rawKey: string, storedHash: string): boolean {
    return safeEqual(sha256Hex(rawKey), storedHash);
  }
}