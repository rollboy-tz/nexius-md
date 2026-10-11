// path: src/routes/auth.routes.ts

import { Router } from 'express';
import { AuthController } from '../controllers/auth.controller.js';
import { authenticate, requireTrustedOrigin } from '../middlewares/auth.middleware.js';
import { rateLimit } from '../middlewares/rate-limit.middleware.js';
import { validate } from '../middlewares/validate-request.middleware.js';
import { authSchema } from '../schemas/auth.schema.js';

/**
 * Mount:  app.use('/api/v1/auth', authRoutes);
 *
 * Public routes:        rate limit -> origin check -> validation -> controller
 * Authenticated routes: authenticate (cookie or bearer, silent refresh) -> validation -> controller
 *
 * Limits are per IP (set `app.set('trust proxy', ...)` so that is the real client). Login and
 * password reset are ALSO limited per email inside AuthService, so one account cannot be hammered
 * from many addresses.
 */
const router = Router();

const MINUTE = 60;
const FIFTEEN_MINUTES = 15 * MINUTE;
const HOUR = 60 * MINUTE;

const limit = {
  checkEmail: rateLimit({ name: 'auth-check-email', limit: 10, windowSeconds: FIFTEEN_MINUTES }),
  register: rateLimit({ name: 'auth-register', limit: 10, windowSeconds: HOUR }),
  verify: rateLimit({ name: 'auth-verify', limit: 20, windowSeconds: FIFTEEN_MINUTES }),
  resend: rateLimit({ name: 'auth-resend', limit: 5, windowSeconds: FIFTEEN_MINUTES }),
  login: rateLimit({ name: 'auth-login', limit: 20, windowSeconds: FIFTEEN_MINUTES }),
  refresh: rateLimit({ name: 'auth-refresh', limit: 60, windowSeconds: MINUTE }),
  forgot: rateLimit({ name: 'auth-forgot', limit: 5, windowSeconds: FIFTEEN_MINUTES }),
  reset: rateLimit({ name: 'auth-reset', limit: 10, windowSeconds: FIFTEEN_MINUTES }),
};

/* ----------------------------------------------------------------------------
 * Public
 * -------------------------------------------------------------------------- */

/** Identifier-first helper. It reveals whether an email exists, so it has the tightest limit. */
router.post('/check-email', limit.checkEmail, requireTrustedOrigin, validate(authSchema.checkEmail), AuthController.checkEmail);

/** Creates the account and its organization (or joins one, with inviteToken). */
router.post('/register', limit.register, requireTrustedOrigin, validate(authSchema.register), AuthController.register);

/** Consumes the emailed token. Signs the user in: cookies for browsers, body tokens for mobile. */
router.post('/verify-email', limit.verify, requireTrustedOrigin, validate(authSchema.verifyEmail), AuthController.verifyEmail);

router.post(
  '/resend-verification',
  limit.resend,
  requireTrustedOrigin,
  validate(authSchema.resendVerification),
  AuthController.resendVerification,
);

router.post('/login', limit.login, requireTrustedOrigin, validate(authSchema.login), AuthController.login);

/** Browser: no body, refresh cookie. Mobile: { refreshToken } in the body. */
router.post('/refresh', limit.refresh, requireTrustedOrigin, validate(authSchema.refresh), AuthController.refresh);

router.post('/forgot-password', limit.forgot, requireTrustedOrigin, validate(authSchema.forgotPassword), AuthController.forgotPassword);

router.post('/reset-password', limit.reset, requireTrustedOrigin, validate(authSchema.resetPassword), AuthController.resetPassword);

/* ----------------------------------------------------------------------------
 * Authenticated
 * -------------------------------------------------------------------------- */

router.post('/logout', authenticate, AuthController.logout);
router.post('/logout-all', authenticate, AuthController.logoutAll);

router.get('/sessions', authenticate, AuthController.listSessions);
router.delete('/sessions/:sessionId', authenticate, validate(authSchema.sessionParam), AuthController.revokeSession);

router.get('/me', authenticate, AuthController.me);
router.patch('/me', authenticate, validate(authSchema.updateProfile), AuthController.updateMe);
router.post('/me/password', authenticate, validate(authSchema.changePassword), AuthController.changePassword);

export default router;