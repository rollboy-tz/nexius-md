// path: src/utils/auth-cookies.ts

import type { CookieOptions, Request, Response } from 'express';
import { env } from '../config/env.js';
import type { AuthTokens } from '../services/auth.service.js';
import { ApiError } from './api.error.js';

/* ============================================================================
 * Configuration (all optional; the defaults are the safe ones)
 *
 *   COOKIE_SAME_SITE  lax (default) | strict | none
 *                     Web app and API on the same site (app.example.com + api.example.com): lax.
 *                     Different sites entirely: none (needs HTTPS, and the origin check below
 *                     becomes your main CSRF defence).
 *   COOKIE_DOMAIN     only when the cookie must be shared across subdomains. Leave empty otherwise.
 *   COOKIE_SECURE     "true" to force Secure outside production (HTTPS dev setups).
 * ========================================================================== */

type SameSite = 'lax' | 'strict' | 'none';

function parseSameSite(value: string | undefined): SameSite {
  const sameSite = (value ?? 'lax').trim().toLowerCase();
  if (sameSite !== 'lax' && sameSite !== 'strict' && sameSite !== 'none') {
    throw new Error('COOKIE_SAME_SITE must be "lax", "strict" or "none".');
  }
  return sameSite;
}

const isProduction = env.NODE_ENV === 'production';
const secure = isProduction || env.COOKIE_SECURE === 'true';
const domain = process.env.COOKIE_DOMAIN?.trim() || undefined;
const sameSite = parseSameSite(env.COOKIE_SAME_SITE);

if (sameSite === 'none' && !secure && isProduction) {
  throw new Error('COOKIE_SAME_SITE=none requires HTTPS (set COOKIE_SECURE=true or run in production).');
}

/**
 * "__Host-" makes the browser refuse the cookie unless it is Secure, path "/" and has no Domain,
 * so a sibling subdomain cannot plant or overwrite it. "__Secure-" is the variant allowed with a Domain.
 */
const prefix = secure ? (domain ? '__Secure-' : '__Host-') : '';

export const ACCESS_COOKIE = `${prefix}nx_at`;
export const REFRESH_COOKIE = `${prefix}nx_rt`;

/** Must match token.service: access token 15 minutes, refresh idle timeout 7 days (renewed on every rotation). */
const ACCESS_MAX_AGE_MS = 15 * 60 * 1000;
const REFRESH_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// HttpOnly is not optional and not configurable: no script on the page can ever read these.
const BASE_OPTIONS: CookieOptions = {
  httpOnly: true,
  secure,
  sameSite,
  path: '/',
  ...(domain ? { domain } : {}),
};

/* ============================================================================
 * Cookies
 * ========================================================================== */

export function setAuthCookies(res: Response, tokens: AuthTokens): void {
  res.cookie(ACCESS_COOKIE, tokens.accessToken, { ...BASE_OPTIONS, maxAge: ACCESS_MAX_AGE_MS });
  res.cookie(REFRESH_COOKIE, tokens.refreshToken, { ...BASE_OPTIONS, maxAge: REFRESH_MAX_AGE_MS });
}

/** clearCookie only works with the same attributes the cookie was set with. */
export function clearAuthCookies(res: Response): void {
  res.clearCookie(ACCESS_COOKIE, BASE_OPTIONS);
  res.clearCookie(REFRESH_COOKIE, BASE_OPTIONS);
}

export function readAuthCookies(req: Request): { accessToken?: string | undefined; refreshToken?: string | undefined } {
  // Needs cookie-parser. Read through `unknown` so this file does not depend on its typings.
  const jar: unknown = (req as Request & { cookies?: unknown }).cookies;
  const record = typeof jar === 'object' && jar !== null ? (jar as Record<string, unknown>) : {};

  const pick = (name: string): string | undefined => {
    const value = record[name];
    return typeof value === 'string' && value.length > 0 && value.length <= 4096 ? value : undefined;
  };

  return { accessToken: pick(ACCESS_COOKIE), refreshToken: pick(REFRESH_COOKIE) };
}

/* ============================================================================
 * Browser origin check (CSRF)
 *
 * A cookie is sent by the browser automatically, even when another site triggers the request.
 * SameSite helps, but the real guarantee is checking WHO is asking:
 *   1. an Origin header must be one of ours, or
 *   2. with no Origin, Sec-Fetch-Site must say same-origin / same-site, or
 *   3. when `requireProof` is set and neither header exists, the request is refused.
 * Bearer-token requests are not affected: a foreign site cannot attach a header it cannot read.
 * ========================================================================== */

const allowedOrigins: readonly string[] = (
  Array.isArray(env.CORS_ORIGIN) ? env.CORS_ORIGIN : String(env.CORS_ORIGIN).split(',')
)
  .map((origin: string) => origin.trim())
  .filter(Boolean);

const allowAnyOrigin = allowedOrigins.includes('*');
const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const rejectOrigin = (): ApiError =>
  ApiError.forbidden('This request origin is not allowed.', 'ORIGIN_NOT_ALLOWED');

export function assertTrustedOrigin(req: Request, options: { requireProof: boolean }): void {
  if (!UNSAFE_METHODS.has(req.method)) return;

  const origin = req.get('origin');
  if (origin) {
    if (allowAnyOrigin || allowedOrigins.includes(origin)) return;
    throw rejectOrigin();
  }

  const fetchSite = req.get('sec-fetch-site');
  if (fetchSite) {
    if (fetchSite === 'same-origin' || fetchSite === 'same-site' || fetchSite === 'none') return;
    throw rejectOrigin();
  }

  if (options.requireProof) throw rejectOrigin();
}

/** WebSocket haikingwi na CORS ya browser. Kwa handshake yenye cookie, asili lazima iwe yetu. */
export function isAllowedOrigin(origin: string | undefined): boolean {
  return Boolean(origin) && (allowAnyOrigin || allowedOrigins.includes(origin as string));
}
