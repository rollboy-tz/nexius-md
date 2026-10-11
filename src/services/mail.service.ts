/**
 * Mail port. Replace the body of `deliver` with your provider (Resend, SES, Postmark, SMTP).
 * Services depend on this interface only, so the provider can change without touching them.
 */

import { env } from "../config/env.js";

export interface InviteMail {
  organizationName: string;
  inviterName: string;
  role: string;
  expiresAt: Date;
}

const APP_URL = (env.FRONTEND_URL).replace(/\/$/, '');
const isProduction = process.env.NODE_ENV === 'production';

const link = (path: string, token: string): string => `${APP_URL}${path}?token=${encodeURIComponent(token)}`;

async function deliver(to: string, subject: string, text: string): Promise<void> {
  if (isProduction) {
    // Wire a real transport here. Failing loudly beats pretending an email was sent.
    throw new Error('Mail transport is not configured.');
  }

  // Development only: links are printed so you can click them. Never log tokens in production.
  console.log(`\n✉️  [Mail:dev] to=${to}\n   subject=${subject}\n   ${text}\n`);
}

export const mailService = {
  sendEmailVerification: (to: string, token: string) =>
    deliver(to, 'Verify your email', `Open this link to verify your email: ${link('/verify-email', token)}`),

  sendPasswordReset: (to: string, token: string) =>
    deliver(to, 'Reset your password', `Open this link to choose a new password: ${link('/reset-password', token)}`),

  sendOrganizationInvite: (to: string, token: string, invite: InviteMail) =>
    deliver(
      to,
      `${invite.inviterName} invited you to ${invite.organizationName}`,
      `You were invited as ${invite.role}. Accept before ${invite.expiresAt.toISOString()}: ${link('/invitations/accept', token)}`,
    ),
};

/**
 * Sending an email must never fail the request that already committed its database work
 * (the user can always ask for another email). Failures are logged, not thrown.
 */
export async function trySend(send: () => Promise<void>): Promise<void> {
  try {
    await send();
  } catch (error) {
    console.error('❌ [Mail] Delivery failed:', error instanceof Error ? error.message : error);
  }
}