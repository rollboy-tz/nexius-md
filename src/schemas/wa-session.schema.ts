// path: src/schemas/wa-session.schema.ts

import { z } from 'zod';

const uuid = z.string().uuid('Invalid id');

/** "+255 712-345-678" is accepted and normalised to "255712345678". Must end up 8 to 15 digits. */
const phoneNumber = z
  .string()
  .trim()
  .max(32)
  .transform((value) => value.replace(/\D/g, ''))
  .pipe(z.string().regex(/^\d{8,15}$/, 'Phone number must have 8 to 15 digits, including the country code'));

/** Every session route lives under /organizations/:organizationId/channels/:channelId. */
const channelParams = { params: z.object({ organizationId: uuid, channelId: uuid }) };

export const sessionSchema = {
  status: channelParams,

  initiate: {
    ...channelParams,
    body: z.object({ phoneNumber: phoneNumber.optional() }).strict().default({}),
  },

  pair: {
    ...channelParams,
    body: z.object({ phoneNumber }).strict(),
  },

  disconnect: channelParams,

  sendMessage: {
    ...channelParams,
    body: z
      .object({
        /** A phone number, a user JID or a group JID. The session manager normalises it. */
        to: z.string().trim().min(1).max(128),
        text: z.string().trim().min(1, 'Message cannot be empty').max(4096, 'Message is too long'),
      })
      .strict(),
  },
};

export type InitiateBody = z.infer<typeof sessionSchema.initiate.body>;
export type PairBody = z.infer<typeof sessionSchema.pair.body>;
export type SendMessageBody = z.infer<typeof sessionSchema.sendMessage.body>;
export type ChannelParams = z.infer<typeof sessionSchema.status.params>;