// path: src/schemas/organization.schema.ts

import { z } from 'zod';
import { ASSIGNABLE_ROLES } from '../auth/permissions.js';

/* ============================================================================
 * Primitives
 * ========================================================================== */

const uuid = z.string().uuid('Invalid id');
const name = z.string().trim().min(2, 'Name is too short').max(100, 'Name is too long');
const email = z.string().trim().toLowerCase().max(320).email('Invalid email address');
const oneTimeToken = z.string().trim().min(20).max(512);

/** OWNER is deliberately absent: it moves only through transfer-ownership. */
const assignableRole = z.enum(ASSIGNABLE_ROLES);

const orgParams = z.object({ organizationId: uuid });
const memberParams = z.object({ organizationId: uuid, userId: uuid });
const inviteParams = z.object({ organizationId: uuid, inviteId: uuid });

const pagination = {
  page: z.coerce.number().int().min(1).max(10_000).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
};
const search = z.string().trim().max(100).optional();

/* ============================================================================
 * Schemas
 * ========================================================================== */

export const organizationSchema = {
  create: { body: z.object({ name }).strict() },

  get: { params: orgParams },

  roles: { params: orgParams },

  rename: { params: orgParams, body: z.object({ name }).strict() },

  /** The caller must type the organization's current name, as a guard against a misclick. */
  remove: { params: orgParams, body: z.object({ confirmName: z.string().trim().min(1).max(100) }).strict() },

  leave: { params: orgParams },

  transferOwnership: { params: orgParams, body: z.object({ userId: uuid }).strict() },

  /* ------------------------------- members ------------------------------- */

  listMembers: { params: orgParams, query: z.object({ ...pagination, search }) },

  updateMemberRole: { params: memberParams, body: z.object({ role: assignableRole }).strict() },

  setMemberStatus: {
    params: memberParams,
    body: z.object({ status: z.enum(['ACTIVE', 'SUSPENDED']) }).strict(),
  },

  removeMember: { params: memberParams },

  /* ----------------------------- invitations ----------------------------- */

  listInvites: { params: orgParams },

  createInvite: {
    params: orgParams,
    body: z.object({ email, role: assignableRole.default('MEMBER') }).strict(),
  },

  revokeInvite: { params: inviteParams },

  resendInvite: { params: inviteParams },

  /** Public: the token in the emailed link is the credential. */
  previewInvite: { query: z.object({ token: oneTimeToken }) },

  /** Signed-in user accepts. The invitation must be addressed to their email. */
  acceptInvite: { body: z.object({ token: oneTimeToken }).strict() },

  /* -------------------------------- audit -------------------------------- */

  auditLogs: {
    params: orgParams,
    query: z.object({
      ...pagination,
      action: z
        .string()
        .trim()
        .max(100)
        .regex(/^[a-z_.]+$/, 'Invalid action')
        .optional(),
      actorUserId: uuid.optional(),
      from: z.coerce.date().optional(),
      to: z.coerce.date().optional(),
    }),
  },
};

export type CreateOrganizationBody = z.infer<typeof organizationSchema.create.body>;
export type RenameOrganizationBody = z.infer<typeof organizationSchema.rename.body>;
export type DeleteOrganizationBody = z.infer<typeof organizationSchema.remove.body>;
export type TransferOwnershipBody = z.infer<typeof organizationSchema.transferOwnership.body>;
export type ListMembersQuery = z.infer<typeof organizationSchema.listMembers.query>;
export type MemberParams = z.infer<typeof organizationSchema.updateMemberRole.params>;
export type UpdateMemberRoleBody = z.infer<typeof organizationSchema.updateMemberRole.body>;
export type SetMemberStatusBody = z.infer<typeof organizationSchema.setMemberStatus.body>;
export type CreateInviteBody = z.infer<typeof organizationSchema.createInvite.body>;
export type InviteParams = z.infer<typeof organizationSchema.revokeInvite.params>;
export type PreviewInviteQuery = z.infer<typeof organizationSchema.previewInvite.query>;
export type AcceptInviteBody = z.infer<typeof organizationSchema.acceptInvite.body>;
export type AuditLogsQuery = z.infer<typeof organizationSchema.auditLogs.query>;
