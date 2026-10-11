// path: src/routes/organization.routes.ts

import { Router } from 'express';
import { OrganizationController } from '../controllers/organization.controller.js';
import { authenticate, requireOrganization, requirePermission, requireTrustedOrigin } from '../middlewares/auth.middleware.js';
import { rateLimit } from '../middlewares/rate-limit.middleware.js';
import { validate } from '../middlewares/validate-request.middleware.js';
import { organizationSchema } from '../schemas/organization.schema.js';
import { automationRoutes, templateRoutes } from './automation.routes.js';
import channelRoutes from './channel.routes.js';

/**
 * Mount in app.ts:
 *
 *   app.use('/api/v1/organizations', organizationRoutes);
 *   app.use('/api/v1/invitations',   invitationRoutes);
 *
 * Shape:
 *   /organizations                    create one more organization        (signed in)
 *   /organizations/:organizationId/*  everything inside one organization  (member only, 404 otherwise)
 *   /organizations/:organizationId/channels/*   channels and live sessions (channel.routes.ts)
 *   /invitations/*                    public preview and "accept"
 *
 * authenticate and requireOrganization() are applied ONCE on the tenant router, so nested routers
 * (channels, sessions) never repeat them. Each route then adds only requirePermission + validate.
 */

/* ============================================================================
 * Tenant router: /organizations/:organizationId/...
 * ========================================================================== */

const tenant = Router({ mergeParams: true });

tenant.use(authenticate, requireOrganization());

/** The invitation limiter counts per organization, so one organization cannot be used to spam. */
const inviteLimit = rateLimit({
  name: 'org-invite',
  limit: 30,
  windowSeconds: 60 * 60,
  keyBy: (req) => String(req.params.organizationId),
});

/* ---- the organization itself ---- */
tenant.get('/', requirePermission('org:read'), validate(organizationSchema.get), OrganizationController.get);
/** What each role may do (read-only). @access org:read */
tenant.get('/roles', requirePermission('org:read'), validate(organizationSchema.roles), OrganizationController.roles);

tenant.patch('/', requirePermission('org:update'), validate(organizationSchema.rename), OrganizationController.rename);
tenant.delete('/', requirePermission('org:delete'), validate(organizationSchema.remove), OrganizationController.remove);

/** Any member may leave; the last OWNER may not (the service refuses). So no permission, only membership. */
tenant.post('/leave', validate(organizationSchema.leave), OrganizationController.leave);
tenant.post(
  '/transfer-ownership',
  requirePermission('org:transfer'),
  validate(organizationSchema.transferOwnership),
  OrganizationController.transferOwnership,
);

/* ---- members ---- */
tenant.get('/members', requirePermission('member:read'), validate(organizationSchema.listMembers), OrganizationController.listMembers);
tenant.patch(
  '/members/:userId',
  requirePermission('member:update_role'),
  validate(organizationSchema.updateMemberRole),
  OrganizationController.updateMemberRole,
);
tenant.patch(
  '/members/:userId/status',
  requirePermission('member:remove'),
  validate(organizationSchema.setMemberStatus),
  OrganizationController.setMemberStatus,
);
tenant.delete(
  '/members/:userId',
  requirePermission('member:remove'),
  validate(organizationSchema.removeMember),
  OrganizationController.removeMember,
);

/* ---- invitations ---- */
tenant.get('/invites', requirePermission('member:invite'), validate(organizationSchema.listInvites), OrganizationController.listInvites);
tenant.post(
  '/invites',
  inviteLimit,
  requirePermission('member:invite'),
  validate(organizationSchema.createInvite),
  OrganizationController.createInvite,
);
tenant.post(
  '/invites/:inviteId/resend',
  inviteLimit,
  requirePermission('member:invite'),
  validate(organizationSchema.resendInvite),
  OrganizationController.resendInvite,
);
tenant.delete(
  '/invites/:inviteId',
  requirePermission('member:invite'),
  validate(organizationSchema.revokeInvite),
  OrganizationController.revokeInvite,
);

/* ---- audit ---- */
tenant.get('/audit-logs', requirePermission('audit:read'), validate(organizationSchema.auditLogs), OrganizationController.auditLogs);

/* ---- channels and their live sessions ---- */
tenant.use('/channels', channelRoutes);

/* ---- saved messages and automations ---- */
tenant.use('/templates', templateRoutes);
tenant.use('/automations', automationRoutes);

/* ============================================================================
 * /organizations
 * ========================================================================== */

const organizations = Router();

/** An additional organization for a signed-in user (agencies, several businesses). */
organizations.post(
  '/',
  rateLimit({ name: 'org-create', limit: 5, windowSeconds: 60 * 60 }),
  authenticate,
  validate(organizationSchema.create),
  OrganizationController.create,
);

organizations.use('/:organizationId', tenant);

export default organizations;

/* ============================================================================
 * /invitations (not tied to a membership: the token is the credential)
 * ========================================================================== */

export const invitationRoutes = Router();

/** Public. Tokens are long and random, but the route is still limited so it cannot be used as an oracle. */
invitationRoutes.get(
  '/preview',
  rateLimit({ name: 'invite-preview', limit: 30, windowSeconds: 15 * 60 }),
  validate(organizationSchema.previewInvite),
  OrganizationController.previewInvite,
);

/** Signed-in user, invitation addressed to their email. Users who do not exist yet register with inviteToken instead. */
invitationRoutes.post(
  '/accept',
  rateLimit({ name: 'invite-accept', limit: 20, windowSeconds: 15 * 60 }),
  requireTrustedOrigin,
  authenticate,
  validate(organizationSchema.acceptInvite),
  OrganizationController.acceptInvite,
);
