// path: src/schemas/channel.schema.ts

import { z } from 'zod';
import { safetySettingsPatchSchema } from '../config/safety.js';

const uuid = z.string().uuid('Invalid id');
const displayName = z.string().trim().min(2, 'Name is too short').max(100, 'Name is too long');

const orgParams = z.object({ organizationId: uuid });
const channelParams = z.object({ organizationId: uuid, channelId: uuid });

/** Keep in step with SUPPORTED_PROVIDERS in channel.service.ts. Add a provider here when you implement it. */
const provider = z.enum(['WHATSAPP']);

export const channelSchema = {
  list: { params: orgParams },

  create: {
    params: orgParams,
    body: z.object({ provider: provider.default('WHATSAPP'), displayName }).strict(),
  },

  get: { params: channelParams },

  rename: { params: channelParams, body: z.object({ displayName }).strict() },

  remove: { params: channelParams },

  groups: { params: channelParams, query: z.object({ refresh: z.enum(['true', 'false']).optional().transform((v) => v === 'true') }) },

  contacts: {
    params: channelParams,
    query: z.object({ search: z.string().trim().max(32).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }),
  },

  /** Any subset of the safety settings. Unknown keys are rejected. */
  updateSettings: {
    params: channelParams,
    body: safetySettingsPatchSchema.refine((value) => Object.values(value).some((field) => field !== undefined), {
      message: 'Provide at least one setting to change',
    }),
  },
};

export type ListContactsQuery = z.infer<typeof channelSchema.contacts.query>;
export type ListGroupsQuery = z.infer<typeof channelSchema.groups.query>;
export type CreateChannelBody = z.infer<typeof channelSchema.create.body>;
export type RenameChannelBody = z.infer<typeof channelSchema.rename.body>;
export type UpdateChannelSettingsBody = z.infer<typeof channelSchema.updateSettings.body>;
