// src/schemas/message.schema.ts
import { z } from 'zod';

export const baseOptionsSchema = z
  .object({
    mentions: z.array(z.string()).optional(),
    forwarded: z.boolean().optional(),
    forwardingScore: z.number().int().min(1).optional()
  })
  .strict();

export const textMessageSchema = z.object({
  type: z.literal('text'),
  recipientJid: z.string().min(5, 'Invalid recipient JID or phone number'),
  text: z.string().min(1, 'Text content cannot be empty'),
  options: baseOptionsSchema.optional()
});

export const imageMessageSchema = z.object({
  type: z.literal('image'),
  recipientJid: z.string().min(5, 'Invalid recipient JID or phone number'),
  image: z.string().url('Image must be a valid HTTP/HTTPS URL'),
  caption: z.string().optional(),
  options: baseOptionsSchema.optional()
});

export const stickerMessageSchema = z.object({
  type: z.literal('sticker'),
  recipientJid: z.string().min(5, 'Invalid recipient JID or phone number'),
  sticker: z.string().url('Sticker must be a valid HTTP/HTTPS URL'),
  options: baseOptionsSchema.optional()
});

export const outboundMessageSchema = z.discriminatedUnion('type', [
  textMessageSchema,
  imageMessageSchema,
  stickerMessageSchema
]);

export type OutboundMessageInput = z.infer<typeof outboundMessageSchema>;