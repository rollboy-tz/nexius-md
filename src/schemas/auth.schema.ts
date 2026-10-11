// path: src/schemas/auth.schema.ts

import { z } from 'zod';

/* ============================================================================
 * Primitives
 * ========================================================================== */

const email = z.string().trim().toLowerCase().max(320).email('Invalid email address');

/** Policy for NEW passwords. Login accepts any length up to the cap, so older accounts can still sign in. */
const newPassword = z.string().min(10, 'Password must be at least 10 characters').max(128, 'Password is too long');
const currentPassword = z.string().min(1, 'Password is required').max(128);

/** Emailed one-time tokens (verification, reset, invitation). */
const oneTimeToken = z.string().trim().min(20).max(512);

/** "<sessionId>.<secret>". Only mobile clients ever send it in a body. */
const refreshToken = z.string().trim().min(60).max(200);

const fullName = z.string().trim().min(2, 'Name is too short').max(255);

/* ============================================================================
 * Schemas. `.strict()` rejects unknown fields, so nothing unexpected reaches the services.
 * ========================================================================== */

export const authSchema = {
  checkEmail: { body: z.object({ email }).strict() },

  register: {
    body: z
      .object({
        fullName,
        email,
        password: newPassword,
        businessName: z.string().trim().min(2).max(100).optional(),
        inviteToken: oneTimeToken.optional(),
        // ------ Trackng data -------------------------
        campaign: z.string().trim().nullable().optional(),
        source: z.string().trim().nullable().optional(),
        medium: z.string().trim().nullable().optional(),
        ref: z.string().trim().nullable().optional(),
      })
      .strict()
      .refine((value) => Boolean(value.inviteToken) || Boolean(value.businessName), {
        message: 'businessName is required unless you are joining through an invitation',
        path: ['businessName'],
      }),
  },

  verifyEmail: { body: z.object({ token: oneTimeToken }).strict() },

  resendVerification: { body: z.object({ email }).strict() },

  login: { body: z.object({ email, password: currentPassword }).strict() },

  /** Browsers send nothing (the refresh cookie is used). Mobile sends { refreshToken }. */
  refresh: { body: z.object({ refreshToken: refreshToken.optional() }).strict().default({}) },

  forgotPassword: { body: z.object({ email }).strict() },

  resetPassword: { body: z.object({ token: oneTimeToken, newPassword }).strict() },

  updateProfile: {
    body: z
      .object({
        fullName: fullName.optional(),
        phoneNumber: z
          .string()
          .trim()
          .max(32)
          .regex(/^\+?[\d\s()-]{6,32}$/, 'Invalid phone number')
          .nullable()
          .optional(),
      })
      .strict()
      .refine((value) => value.fullName !== undefined || value.phoneNumber !== undefined, {
        message: 'Provide at least one field to update',
      }),
  },

  changePassword: { body: z.object({ currentPassword, newPassword }).strict() },

  sessionParam: { params: z.object({ sessionId: z.string().uuid('Invalid session id') }) },
};

/* ============================================================================
 * Types for controllers: `bodyOf<RegisterBody>(req)` after validate(authSchema.register)
 * ========================================================================== */

export type CheckEmailBody = z.infer<typeof authSchema.checkEmail.body>;
export type RegisterBody = z.infer<typeof authSchema.register.body>;
export type VerifyEmailBody = z.infer<typeof authSchema.verifyEmail.body>;
export type ResendVerificationBody = z.infer<typeof authSchema.resendVerification.body>;
export type LoginBody = z.infer<typeof authSchema.login.body>;
export type RefreshBody = z.infer<typeof authSchema.refresh.body>;
export type ForgotPasswordBody = z.infer<typeof authSchema.forgotPassword.body>;
export type ResetPasswordBody = z.infer<typeof authSchema.resetPassword.body>;
export type UpdateProfileBody = z.infer<typeof authSchema.updateProfile.body>;
export type ChangePasswordBody = z.infer<typeof authSchema.changePassword.body>;
export type SessionParams = z.infer<typeof authSchema.sessionParam.params>;