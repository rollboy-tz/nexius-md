import type { OrgRole, PlatformRole } from '../db/schema.js';

export type Permission =
  | 'org:read' | 'org:update' | 'org:delete' | 'org:transfer'
  | 'member:read' | 'member:invite' | 'member:update_role' | 'member:remove'
  | 'channel:read' | 'channel:create' | 'channel:manage' | 'channel:delete'
  | 'message:send' | 'apikey:manage' | 'audit:read';

const RANK: Record<OrgRole, number> = { VIEWER: 1, MEMBER: 2, ADMIN: 3, OWNER: 4 };

const VIEWER: readonly Permission[] = ['org:read', 'member:read', 'channel:read'];
const MEMBER: readonly Permission[] = [...VIEWER, 'message:send'];
const ADMIN: readonly Permission[] = [
  ...MEMBER, 'org:update', 'member:invite', 'member:update_role', 'member:remove',
  'channel:create', 'channel:manage', 'channel:delete', 'apikey:manage', 'audit:read',
];
const OWNER: readonly Permission[] = [...ADMIN, 'org:delete', 'org:transfer'];

const PERMISSIONS: Record<OrgRole, ReadonlySet<Permission>> = {
  VIEWER: new Set(VIEWER), MEMBER: new Set(MEMBER), ADMIN: new Set(ADMIN), OWNER: new Set(OWNER),
};

export const hasOrgPermission = (role: OrgRole, permission: Permission): boolean =>
  PERMISSIONS[role].has(permission);

/** OWNER is never assigned or invited; it moves only through transferOwnership. */
export const ASSIGNABLE_ROLES = ['ADMIN', 'MEMBER', 'VIEWER'] as const satisfies readonly OrgRole[];
export type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];

/** You can only manage people ranked strictly below you. */
export const canManageMember = (actor: OrgRole, target: OrgRole): boolean => RANK[actor] > RANK[target];
/** You can only hand out roles ranked strictly below your own. */
export const canAssignRole = (actor: OrgRole, role: OrgRole): boolean => RANK[actor] > RANK[role];

const PLATFORM_RANK: Record<PlatformRole, number> = { USER: 0, SUPPORT: 1, SUPER_ADMIN: 2 };
export const hasPlatformRole = (role: PlatformRole, minimum: PlatformRole): boolean =>
  PLATFORM_RANK[role] >= PLATFORM_RANK[minimum];