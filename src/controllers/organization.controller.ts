// path: src/controllers/organization.controller.ts

import type { Request } from 'express';
import { hasOrgPermission, type Permission } from '../auth/permissions.js';
import { resolveLimits } from '../config/plans.js';
import { getAuthUser, getOrgContext } from '../middlewares/auth.middleware.js';
import { bodyOf, paramsOf, queryOf } from '../middlewares/validate-request.middleware.js';
import type {
  AcceptInviteBody,
  AuditLogsQuery,
  CreateInviteBody,
  CreateOrganizationBody,
  DeleteOrganizationBody,
  InviteParams,
  ListMembersQuery,
  MemberParams,
  PreviewInviteQuery,
  RenameOrganizationBody,
  SetMemberStatusBody,
  TransferOwnershipBody,
  UpdateMemberRoleBody,
} from '../schemas/organization.schema.js';
import { AuditService } from '../services/audit.service.js';
import { OrganizationService, type Actor } from '../services/organization.service.js';
import { ApiError } from '../utils/api.error.js';
import { catchAsync } from '../utils/catch-async.util.js';
import { metaOf } from '../utils/request-meta.js';
import { ApiResponse } from '../utils/api-response.util.js'; // adjust to where your ApiResponse lives

/** Caller plus display name (needed to sign invitation emails). Role comes from req.org, never from the client. */
function actorOf(req: Request): Actor & { fullName: string } {
  const user = getAuthUser(req);
  return { userId: user.userId, role: getOrgContext(req).role, fullName: user.fullName };
}

/**
 * Handlers for routes under /organizations/:organizationId run after authenticate,
 * requireOrganization() and requirePermission(...), so `getOrgContext(req)` is always the caller's
 * verified standing. The service layer re-checks rank rules (nobody manages an equal or higher role).
 */
export const OrganizationController = {
  /* ------------------------------ organization ------------------------------ */

  /** An additional organization for the signed-in user (not scoped to an existing one). */
  create: catchAsync(async (req, res) => {
    const { name } = bodyOf<CreateOrganizationBody>(req);
    const organization = await OrganizationService.create(getAuthUser(req), name, metaOf(req));

    return ApiResponse.success(res, 'Organization created.', {
      id: organization.id,
      name: organization.name,
      slug: organization.slug,
      planType: organization.planType,
    });
  }),

  /**
   * What each role may do, computed by asking the SAME check the routes use (hasOrgPermission), so this
   * table can never disagree with what the server enforces. Read-only: roles are fixed, not editable.
   */
  roles: catchAsync(async (req, res) => {
    const { role } = getOrgContext(req);
    const roles = ['OWNER', 'ADMIN', 'MEMBER', 'VIEWER'] as const;
    const catalogue: Array<{ key: Permission; group: string; label: string }> = [
      { key: 'org:read', group: 'Organization', label: 'View organization' },
      { key: 'org:update', group: 'Organization', label: 'Rename organization' },
      { key: 'org:transfer', group: 'Organization', label: 'Transfer ownership' },
      { key: 'org:delete', group: 'Organization', label: 'Delete organization' },
      { key: 'member:read', group: 'People', label: 'View members' },
      { key: 'member:invite', group: 'People', label: 'Invite people' },
      { key: 'member:update_role', group: 'People', label: 'Change roles' },
      { key: 'member:remove', group: 'People', label: 'Suspend or remove members' },
      { key: 'audit:read', group: 'People', label: 'View activity log' },
      { key: 'channel:read', group: 'Channels', label: 'View channels, automations and messages' },
      { key: 'channel:create', group: 'Channels', label: 'Create channels' },
      { key: 'channel:manage', group: 'Channels', label: 'Link numbers, change settings, manage automations' },
      { key: 'channel:delete', group: 'Channels', label: 'Delete channels' },
      { key: 'message:send', group: 'Messages', label: 'Send messages and edit saved messages' },
    ];

    return ApiResponse.success(res, 'Roles.', {
      yourRole: role,
      roles,
      permissions: catalogue.map((item) => ({
        ...item,
        allowed: Object.fromEntries(roles.map((r) => [r, hasOrgPermission(r, item.key)])),
      })),
    });
  }),

  get: catchAsync(async (req, res) => {
    const { organizationId, role } = getOrgContext(req);
    const organization = await OrganizationService.get(organizationId);

    return ApiResponse.success(res, 'Organization.', {
      id: organization.id,
      name: organization.name,
      slug: organization.slug,
      planType: organization.planType,
      status: organization.status,
      createdAt: organization.createdAt,
      myRole: role,
      limits: resolveLimits(organization.planType, organization.limitOverrides),
    });
  }),

  rename: catchAsync(async (req, res) => {
    const { organizationId } = getOrgContext(req);
    const { name } = bodyOf<RenameOrganizationBody>(req);

    const organization = await OrganizationService.rename(organizationId, actorOf(req), name, metaOf(req));
    return ApiResponse.success(res, 'Organization renamed.', { id: organization.id, name: organization.name });
  }),

  /** Soft delete. Typing the current name is required, like on every serious platform. */
  remove: catchAsync(async (req, res) => {
    const { organizationId } = getOrgContext(req);
    const { confirmName } = bodyOf<DeleteOrganizationBody>(req);

    const organization = await OrganizationService.get(organizationId);
    if (organization.name !== confirmName) {
      throw ApiError.badRequest('The name you typed does not match this organization.', 'CONFIRMATION_MISMATCH');
    }

    await OrganizationService.deleteOrganization(organizationId, actorOf(req), metaOf(req));
    return ApiResponse.success(res, 'Organization deleted.', null);
  }),

  leave: catchAsync(async (req, res) => {
    const { organizationId } = getOrgContext(req);

    await OrganizationService.leave(organizationId, getAuthUser(req), metaOf(req));
    return ApiResponse.success(res, 'You left the organization.', null);
  }),

  transferOwnership: catchAsync(async (req, res) => {
    const { organizationId } = getOrgContext(req);
    const { userId } = bodyOf<TransferOwnershipBody>(req);

    await OrganizationService.transferOwnership(organizationId, actorOf(req), userId, metaOf(req));
    return ApiResponse.success(res, 'Ownership transferred. You are now an admin.', null);
  }),

  /* --------------------------------- members --------------------------------- */

  listMembers: catchAsync(async (req, res) => {
    const { organizationId } = getOrgContext(req);
    return ApiResponse.success(res, 'Members.', await OrganizationService.listMembers(organizationId, queryOf<ListMembersQuery>(req)));
  }),

  updateMemberRole: catchAsync(async (req, res) => {
    const { organizationId } = getOrgContext(req);
    const { userId } = paramsOf<MemberParams>(req);
    const { role } = bodyOf<UpdateMemberRoleBody>(req);

    const member = await OrganizationService.updateMemberRole(organizationId, actorOf(req), userId, role, metaOf(req));
    return ApiResponse.success(res, 'Role updated.', member);
  }),

  /** Suspends or reactivates a member in THIS organization only. Their account and other organizations are untouched. */
  setMemberStatus: catchAsync(async (req, res) => {
    const { organizationId } = getOrgContext(req);
    const { userId } = paramsOf<MemberParams>(req);
    const { status } = bodyOf<SetMemberStatusBody>(req);

    await OrganizationService.setMemberStatus(organizationId, actorOf(req), userId, status, metaOf(req));
    return ApiResponse.success(res, status === 'SUSPENDED' ? 'Member suspended.' : 'Member reactivated.', null);
  }),

  removeMember: catchAsync(async (req, res) => {
    const { organizationId } = getOrgContext(req);
    const { userId } = paramsOf<MemberParams>(req);

    await OrganizationService.removeMember(organizationId, actorOf(req), userId, metaOf(req));
    return ApiResponse.success(res, 'Member removed.', null);
  }),

  /* ------------------------------- invitations ------------------------------- */

  listInvites: catchAsync(async (req, res) => {
    const { organizationId } = getOrgContext(req);
    return ApiResponse.success(res, 'Invitations.', await OrganizationService.listInvites(organizationId));
  }),

  createInvite: catchAsync(async (req, res) => {
    const { organizationId } = getOrgContext(req);
    const { email, role } = bodyOf<CreateInviteBody>(req);

    const invite = await OrganizationService.createInvite(organizationId, actorOf(req), { email, role }, metaOf(req));
    return ApiResponse.success(res, 'Invitation sent.', invite);
  }),

  revokeInvite: catchAsync(async (req, res) => {
    const { organizationId } = getOrgContext(req);
    const { inviteId } = paramsOf<InviteParams>(req);

    await OrganizationService.revokeInvite(organizationId, actorOf(req), inviteId, metaOf(req));
    return ApiResponse.success(res, 'Invitation revoked.', null);
  }),

  resendInvite: catchAsync(async (req, res) => {
    const { organizationId } = getOrgContext(req);
    const { inviteId } = paramsOf<InviteParams>(req);

    await OrganizationService.resendInvite(organizationId, actorOf(req), inviteId, metaOf(req));
    return ApiResponse.success(res, 'Invitation sent again.', null);
  }),

  /** Public. Lets the landing page decide between "log in" and "create your account". */
  previewInvite: catchAsync(async (req, res) => {
    const { token } = queryOf<PreviewInviteQuery>(req);

    res.setHeader('Cache-Control', 'no-store');
    return ApiResponse.success(res, 'Invitation.', await OrganizationService.previewInvite(token));
  }),

  /** Signed-in user accepts an invitation addressed to their own email. */
  acceptInvite: catchAsync(async (req, res) => {
    const { token } = bodyOf<AcceptInviteBody>(req);

    const joined = await OrganizationService.acceptInvite(getAuthUser(req), token, metaOf(req));
    return ApiResponse.success(res, 'You joined the organization.', joined);
  }),

  /* --------------------------------- audit --------------------------------- */

  /** The organization's own history. organizationId is forced from the verified context, never from the query. */
  auditLogs: catchAsync(async (req, res) => {
    const { organizationId } = getOrgContext(req);
    const query = queryOf<AuditLogsQuery>(req);

    return ApiResponse.success(res, 'Audit log.', await AuditService.list({ ...query, organizationId }));
  }),
};
