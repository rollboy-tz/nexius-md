import { z } from 'zod';

/**
 * Reusable baseline schema for validating tenant/user session identifiers.
 */
const sessionId = z
  .string({ required_error: 'Session ID is required.' })
  .trim()
  .min(3, 'Session ID must be at least 3 characters long.')
  .max(64, 'Session ID cannot exceed 64 characters.')
  .regex(
    /^[a-zA-Z0-9_-]+$/,
    'Session ID can only contain alphanumeric characters, underscores, or hyphens.'
  );

/**
 * Reusable baseline schema for validating E.164 international telephone format.
 */
const phoneNumber = z
  .string({ required_error: 'Phone number is required.' })
  .trim()
  .transform((val) => val.replace(/[^\d+]/g, '')) // Ondoa spaces na hyphens
  .pipe(
    z
      .string()
      .min(8, 'Phone number must be at least 8 digits.')
      .max(15, 'Phone number cannot exceed 15 digits.')
      .regex(
        /^\+?[1-9]\d{7,14}$/,
        'Invalid E.164 phone number format (e.g., 255712345678 or +255712345678).'
      )
  );

/**
 * Enterprise Consolidated Session Validation Schemas Object.
 * Encapsulates all Zod request schemas and sub-rules for Express middleware validation.
 */
export const sessionSchema = {
  /** Baseline reusable rules */
  rules: {
    sessionId,
    phoneNumber
  },

  /**
   * Validates the /start request payload. phoneNumber is OPTIONAL here,
   * unlike requestPairing — /start's job is just to bring the socket up;
   * the phone number only matters once /pair actually requests a code.
   * Passing it here too is harmless (it gets stored on the session early),
   * so it's accepted but never required.
   *
   * @route POST /api/v1/sessions/start
   */
  initiateSession: z.object({
    body: z
      .object({
        sessionId,
        phoneNumber: phoneNumber.optional()
      })
      .strict()
  }),

  /**
   * Validates pairing code request payload.
   *
   * @route POST /api/v1/sessions/pair
   */
  requestPairing: z.object({
    body: z
      .object({
        sessionId,
        phoneNumber
      })
      .strict()
  }),

  /**
   * Validates URL parameters requiring sessionId.
   *
   * @route GET/DELETE /api/v1/sessions/:sessionId
   */
  sessionParam: z.object({
    params: z
      .object({
        sessionId
      })
      .strict()
  }),

  /**
   * Validates message dispatch request body payload.
   *
   * @route POST /api/v1/sessions/send-message
   */
  sendMessage: z.object({
    body: z
      .object({
        sessionId,
        to: z
          .string({ required_error: 'Recipient destination address (to) is required.' })
          .trim()
          .min(3, 'Recipient destination address is too short.'),
        text: z
          .string({ required_error: 'Message body text cannot be empty.' })
          .trim()
          .min(1, 'Message text cannot be empty or contain only whitespace.')
          .max(4096, 'Message text exceeds maximum allowable WhatsApp length (4096 chars).')
      })
      .strict()
  })
} as const;

/** Inferred TypeScript types from sessionSchema definitions */
export type initiateSessionInput = z.infer<typeof sessionSchema.initiateSession>;
export type RequestPairingInput = z.infer<typeof sessionSchema.requestPairing>;
export type SessionParamInput = z.infer<typeof sessionSchema.sessionParam>;
export type SendMessageInput = z.infer<typeof sessionSchema.sendMessage>;