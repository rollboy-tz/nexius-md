// path: src/middlewares/auth.middleware.ts

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { hasOrgPermission, hasPlatformRole, type Permission } from '../auth/permissions.js';
import type { PlatformRole } from '../db/schema.js';
import { AuthService } from '../services/auth.service.js';
import { AuthSessionService, isUuid, type AuthUser, type OrgContext } from '../services/auth-session.service.js';
import { ApiError } from '../utils/api.error.js';
import { assertTrustedOrigin, clearAuthCookies, readAuthCookies, setAuthCookies } from '../utils/auth-cookies.js';

/** How the caller proved who they are. Cookies are for browsers, bearer headers for mobile and servers. */
export type AuthSource = 'bearer' | 'cookie';

/**
 * Response headers that tell a client's HTTP interceptor what happened to its credentials.
 * They must be listed in CORS `exposedHeaders`, or browsers hide them from scripts.
 */
export const TOKEN_REFRESHED_HEADER = 'X-Token-Refreshed'; // cookies were renewed during this request
export const TOKEN_EXPIRED_HEADER = 'X-Token-Expired'; // bearer client: call POST /auth/refresh, then retry

const BEARER_RE = /^Bearer\s+(\S+)$/i;

const errorCode = (error: unknown): string | undefined => {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  const { code } = error as { code: unknown };
  return typeof code === 'string' ? code : undefined;
};

/* ============================================================================
 * Typed accessors. Use these in controllers instead of `req.user!` / `req.org!`.
 * ========================================================================== */

export function getAuthUser(req: Request): AuthUser {
  if (!req.user) throw ApiError.unauthorized('Authentication required', 'UNAUTHENTICATED');
  return req.user;
}

export function getOrgContext(req: Request): OrgContext {
  if (!req.org) {
    throw ApiError.internal('Organization context missing. Add requireOrganization() to this route.', 'ORG_CONTEXT_MISSING');
  }
  return req.org;
}

/* ============================================================================
 * 0. requireTrustedOrigin: for routes that set or use cookies without authenticate()
 *    (login, register, verify-email, refresh). Browsers always send Origin on cross-site posts.
 * ========================================================================== */

export const requireTrustedOrigin: RequestHandler = (req: Request, _res: Response, next: NextFunction) => {
  try {
    assertTrustedOrigin(req, { requireProof: false });
    next();
  } catch (error) {
    next(error);
  }
};

/* ============================================================================
 * 1. authenticate: who is calling?
 *
 *  Bearer header (mobile, server to server)
 *      valid   -> continue
 *      expired -> 401 ACCESS_TOKEN_EXPIRED + X-Token-Expired. The client calls POST /auth/refresh
 *                 itself. We deliberately do NOT accept a refresh token on every request: a secret
 *                 that long-lived should travel as rarely as possible.
 *
 *  HttpOnly cookies (browsers)
 *      access valid                      -> continue
 *      access expired or cookie gone     -> SILENT REFRESH with the refresh cookie, set new
 *                                           cookies, add X-Token-Refreshed, and continue the
 *                                           SAME request. The user never sees a 401.
 *      refresh invalid / reused / gone   -> cookies cleared, 401 (the client sends them to login)
 *
 *  Warm path touches Redis only. Cookie requests that change data also pass the origin check.
 * ========================================================================== */

export const authenticate: RequestHandler = async (req: Request, res: Response, next: NextFunction) => {
  try {
    /* ---------- bearer ---------- */
    const bearer = BEARER_RE.exec(req.headers.authorization ?? '')?.[1];

    if (bearer) {
      req.authSource = 'bearer';

      try {
        req.user = await AuthSessionService.resolveAccessToken(bearer);
        return next();
      } catch (error) {
        if (errorCode(error) === 'ACCESS_TOKEN_EXPIRED') res.setHeader(TOKEN_EXPIRED_HEADER, 'true');
        throw error;
      }
    }

    /* ---------- cookies ---------- */
    const { accessToken, refreshToken } = readAuthCookies(req);

    if (!accessToken && !refreshToken) {
      throw ApiError.unauthorized('Authentication token missing or malformed', 'MISSING_TOKEN');
    }

    req.authSource = 'cookie';

    // Cookies ride along on requests another site can trigger, so changing requests must prove their origin.
    assertTrustedOrigin(req, { requireProof: true });

    if (accessToken) {
      try {
        req.user = await AuthSessionService.resolveAccessToken(accessToken);
        return next();
      } catch (error) {
        // Only "expired" is worth a refresh. Revoked, suspended or forged credentials end here.
        if (errorCode(error) !== 'ACCESS_TOKEN_EXPIRED' || !refreshToken) {
          clearAuthCookies(res);
          throw error;
        }
      }
    }

    // The browser deletes the access cookie when it expires, so "no access cookie but a refresh
    // cookie" is the normal shape of an expired session, not an error.
    if (!refreshToken) {
      clearAuthCookies(res);
      throw ApiError.unauthorized('Session expired', 'SESSION_EXPIRED');
    }

    try {
      const tokens = await AuthService.refresh(refreshToken);

      setAuthCookies(res, tokens);
      res.setHeader(TOKEN_REFRESHED_HEADER, 'true');

      req.user = await AuthSessionService.resolveAccessToken(tokens.accessToken);
      return next();
    } catch (error) {
      // REFRESH_RETRY means another request of the same browser is mid-rotation: keep the cookies.
      if (errorCode(error) !== 'REFRESH_RETRY') clearAuthCookies(res);
      throw error;
    }
  } catch (error) {
    next(error);
  }
};

/* ============================================================================
 * 2. requireOrganization: which organization, and what is the caller's role in it?
 *    Non-members get 404, not 403, so organization ids cannot be probed.
 *    There is deliberately NO platform-admin bypass: admins use /admin routes.
 * ========================================================================== */

export const requireOrganization =
  (param = 'organizationId'): RequestHandler =>
  async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const user = getAuthUser(req);
      const raw = req.params[param];
      const organizationId = typeof raw === 'string' ? raw : undefined;

      if (!isUuid(organizationId)) {
        throw ApiError.notFound('Organization not found.', 'ORGANIZATION_NOT_FOUND');
      }

      const org = await AuthSessionService.getOrgContext(user.userId, organizationId);
      if (!org) throw ApiError.notFound('Organization not found.', 'ORGANIZATION_NOT_FOUND');

      if (org.organizationStatus !== 'ACTIVE') {
        throw ApiError.forbidden('This organization is suspended.', 'ORGANIZATION_SUSPENDED');
      }

      req.org = org;
      req.organizationId = org.organizationId;
      next();
    } catch (error) {
      next(error);
    }
  };

/* ============================================================================
 * 3. requirePermission: may this role do this?  (after requireOrganization)
 * ========================================================================== */

export const requirePermission =
  (permission: Permission): RequestHandler =>
  (req: Request, _res: Response, next: NextFunction) => {
    try {
      const org = getOrgContext(req);

      if (!hasOrgPermission(org.role, permission)) {
        throw ApiError.forbidden('You do not have permission to perform this action.', 'FORBIDDEN');
      }

      next();
    } catch (error) {
      next(error);
    }
  };

/* ============================================================================
 * 4. requirePlatformRole: platform staff only (/admin routes).
 *    Answers 404 to everyone else so the admin surface is not advertised.
 * ========================================================================== */

export const requirePlatformRole =
  (minimum: Exclude<PlatformRole, 'USER'>): RequestHandler =>
  (req: Request, _res: Response, next: NextFunction) => {
    try {
      const user = getAuthUser(req);

      if (!hasPlatformRole(user.platformRole, minimum)) {
        throw ApiError.notFound('Resource not found.', 'NOT_FOUND');
      }

      next();
    } catch (error) {
      next(error);
    }
  };