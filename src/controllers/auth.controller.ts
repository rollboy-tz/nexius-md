// path: src/controllers/auth.controller.ts

import type { Request, Response } from 'express';
import { TOKEN_REFRESHED_HEADER, getAuthUser } from '../middlewares/auth.middleware.js';
import { bodyOf, paramsOf } from '../middlewares/validate-request.middleware.js';
import type {
  ChangePasswordBody,
  CheckEmailBody,
  ForgotPasswordBody,
  LoginBody,
  RefreshBody,
  RegisterBody,
  ResendVerificationBody,
  ResetPasswordBody,
  SessionParams,
  UpdateProfileBody,
  VerifyEmailBody,
} from '../schemas/auth.schema.js';
import type { RequestMeta } from '../services/audit.service.js';
import { AuthService, type AuthResult, type AuthTokens } from '../services/auth.service.js';
import { ApiError } from '../utils/api.error.js';
import { assertTrustedOrigin, clearAuthCookies, readAuthCookies, setAuthCookies } from '../utils/auth-cookies.js';
import { catchAsync } from '../utils/catch-async.util.js';
import { ApiResponse } from '../utils/api-response.util.js';


/* ============================================================================
 * How credentials leave the server
 *
 *  'cookie'  browsers. Tokens go ONLY into HttpOnly cookies; the body carries no token at all,
 *            so a script injected into the page has nothing to read.
 *  'body'    mobile apps. They have no cookie jar worth trusting and keep tokens in secure storage.
 *            They announce themselves with the header  X-Client-Platform: mobile.
 *
 * Rule that protects the browser case: tokens are put in a body only when the caller supplied a
 * credential explicitly (a password, or a refresh token in the request body). A request that was
 * authenticated by cookie never gets tokens back in its body, even if it fakes the header.
 * ========================================================================== */

type Delivery = 'cookie' | 'body';

const MOBILE_PLATFORMS = new Set(['mobile', 'ios', 'android']);

function deliveryOf(req: Request): Delivery {
  const platform = req.get('x-client-platform')?.trim().toLowerCase();
  return platform && MOBILE_PLATFORMS.has(platform) ? 'body' : 'cookie';
}

const metaOf = (req: Request): RequestMeta => ({
  ipAddress: req.ip,
  userAgent: req.get('user-agent'),
  requestId: req.get('x-request-id'),
});

/** Auth responses carry credentials or account facts: no cache, anywhere. */
function noStore(res: Response): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
}

/** Sends a signed-in session the right way for this client. */
function respondWithSession(res: Response, message: string, result: AuthResult, delivery: Delivery) {
  noStore(res);

  if (delivery === 'cookie') {
    setAuthCookies(res, result.tokens);
    return ApiResponse.success(res, message, { user: result.user, organizations: result.organizations });
  }

  return ApiResponse.success(res, message, result);
}

/* ============================================================================
 * Controller. Validation already happened in the `validate(...)` middleware of each route.
 * ========================================================================== */

export const AuthController = {
  /* ------------------------------ sign-up ------------------------------ */

  checkEmail: catchAsync(async (req, res) => {
    const { email } = bodyOf<CheckEmailBody>(req);
    return ApiResponse.success(res, 'Email checked.', await AuthService.checkEmail(email));
  }),

  register: catchAsync(async (req, res) => {
    const result = await AuthService.register(bodyOf<RegisterBody>(req), metaOf(req));
    noStore(res);

    // Normal sign-up: no session yet, the email must be verified first.
    if (!result.tokens) {
      return ApiResponse.success(res, result.message, { user: result.user, organizationId: result.organizationId });
    }

    // Invitation sign-up: the invite already proved the email, so the user is signed in.
    const tokens: AuthTokens = result.tokens;
    if (deliveryOf(req) === 'cookie') {
      setAuthCookies(res, tokens);
      return ApiResponse.success(res, result.message, { user: result.user, organizationId: result.organizationId });
    }
    return ApiResponse.success(res, result.message, { ...result, tokens });
  }),

  verifyEmail: catchAsync(async (req, res) => {
    const { token } = bodyOf<VerifyEmailBody>(req);
    const result = await AuthService.verifyEmail(token, metaOf(req));
    return respondWithSession(res, 'Email verified.', result, deliveryOf(req));
  }),

  /** Same answer whether or not the address exists. */
  resendVerification: catchAsync(async (req, res) => {
    const { email } = bodyOf<ResendVerificationBody>(req);
    const { message } = await AuthService.resendVerification(email);
    return ApiResponse.success(res, message, null);
  }),

  /* -------------------------------- login -------------------------------- */

  login: catchAsync(async (req, res) => {
    const result = await AuthService.login(bodyOf<LoginBody>(req), metaOf(req));
    return respondWithSession(res, 'Login successful.', result, deliveryOf(req));
  }),

  /**
   * Renews the session.
   *  - Browser: reads the refresh COOKIE, sets new cookies, returns no token. Origin is checked.
   *  - Mobile : sends { refreshToken } in the body and receives the new pair in the body.
   * Normally browsers never call this: authenticate() refreshes silently. It exists for apps that
   * want to renew ahead of time, and for mobile.
   */
  refresh: catchAsync(async (req, res) => {
    const { refreshToken: fromBody } = bodyOf<RefreshBody>(req);
    const delivery: Delivery = fromBody ? 'body' : 'cookie';

    const refreshToken = fromBody ?? readAuthCookies(req).refreshToken;
    if (!refreshToken) throw ApiError.unauthorized('Refresh token missing', 'MISSING_REFRESH_TOKEN');

    if (delivery === 'cookie') assertTrustedOrigin(req, { requireProof: true });

    let tokens: AuthTokens;
    try {
      tokens = await AuthService.refresh(refreshToken);
    } catch (error) {
      if (delivery === 'cookie') clearAuthCookies(res);
      throw error;
    }

    noStore(res);
    res.setHeader(TOKEN_REFRESHED_HEADER, 'true');

    if (delivery === 'cookie') {
      setAuthCookies(res, tokens);
      return ApiResponse.success(res, 'Session renewed.', { refreshed: true });
    }
    return ApiResponse.success(res, 'Session renewed.', { tokens });
  }),

  /* -------------------------------- logout -------------------------------- */

  /** Ends this device. Cookies are cleared even when the revoke itself fails, so the browser is signed out regardless. */
  logout: catchAsync(async (req, res) => {
    const user = getAuthUser(req);

    try {
      await AuthService.logout(user, metaOf(req));
    } finally {
      clearAuthCookies(res);
    }

    noStore(res);
    return ApiResponse.success(res, 'Logged out.', null);
  }),

  logoutAll: catchAsync(async (req, res) => {
    const user = getAuthUser(req);

    try {
      await AuthService.logoutAll(user, metaOf(req));
    } finally {
      clearAuthCookies(res);
    }

    noStore(res);
    return ApiResponse.success(res, 'Logged out of every device.', null);
  }),

  /* ------------------------------ my devices ------------------------------ */

  listSessions: catchAsync(async (req, res) => {
    noStore(res);
    return ApiResponse.success(res, 'Active sessions.', await AuthService.listSessions(getAuthUser(req)));
  }),

  revokeSession: catchAsync(async (req, res) => {
    const { sessionId } = paramsOf<SessionParams>(req);
    const user = getAuthUser(req);

    await AuthService.revokeOwnSession(user, sessionId, metaOf(req));

    // Ending the session you are using also ends this browser's cookies.
    if (sessionId === user.sessionId) clearAuthCookies(res);

    return ApiResponse.success(res, 'Session revoked.', null);
  }),

  /* -------------------------------- profile -------------------------------- */

  me: catchAsync(async (req, res) => {
    noStore(res);
    return ApiResponse.success(res, 'Profile.', await AuthService.getProfile(getAuthUser(req).userId));
  }),

  updateMe: catchAsync(async (req, res) => {
    const user = await AuthService.updateProfile(getAuthUser(req).userId, bodyOf<UpdateProfileBody>(req));
    return ApiResponse.success(res, 'Profile updated.', user);
  }),

  /** The current device stays signed in, every other device is signed out. */
  changePassword: catchAsync(async (req, res) => {
    await AuthService.changePassword(getAuthUser(req), bodyOf<ChangePasswordBody>(req), metaOf(req));
    return ApiResponse.success(res, 'Password changed. Other devices were signed out.', null);
  }),

  /* ----------------------------- password reset ----------------------------- */

  forgotPassword: catchAsync(async (req, res) => {
    const { email } = bodyOf<ForgotPasswordBody>(req);
    const { message } = await AuthService.requestPasswordReset(email);
    return ApiResponse.success(res, message, null);
  }),

  /** Every device is signed out, including this browser: it must log in with the new password. */
  resetPassword: catchAsync(async (req, res) => {
    const { token, newPassword } = bodyOf<ResetPasswordBody>(req);
    await AuthService.resetPassword(token, newPassword, metaOf(req));

    clearAuthCookies(res);
    return ApiResponse.success(res, 'Password reset. Please log in.', null);
  }),
};