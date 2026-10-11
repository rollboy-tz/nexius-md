// path: src/db/schema.ts

import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { PLAN_TYPES, type PlanLimits } from '../config/plans.js';
import type { FormatEntity, MessageMedia, OutboundPayload } from '../types/message.types.js';

/* ============================================================================
 * Conventions
 *  - Every timestamp is timestamptz. updatedAt is maintained by Drizzle on update().
 *  - Emails, slugs are stored lowercase; CHECK constraints enforce it, so plain unique
 *    indexes are enough (and queries can use them).
 *  - Secrets are never stored in clear: tokens are SHA-256 hashes, passwords are argon2id.
 *  - Soft delete (deletedAt) for users, organizations, channels. A purge job removes them later.
 * ========================================================================== */

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());
const tz = (name: string) => timestamp(name, { withTimezone: true });

/* ============================================================================
 * Enums
 * ========================================================================== */

/** Platform-wide role. Only these three exist; organization roles are separate (below). */
export const platformRoleEnum = pgEnum('platform_role', ['USER', 'SUPPORT', 'SUPER_ADMIN']);
/** Role inside ONE organization. Stored on the membership, never on the user. */
export const orgRoleEnum = pgEnum('org_role', ['OWNER', 'ADMIN', 'MEMBER', 'VIEWER']);
export const accountStatusEnum = pgEnum('account_status', ['ACTIVE', 'SUSPENDED', 'PENDING_VERIFICATION']);
export const organizationStatusEnum = pgEnum('organization_status', ['ACTIVE', 'SUSPENDED']);
export const memberStatusEnum = pgEnum('member_status', ['ACTIVE', 'SUSPENDED']);
export const planTypeEnum = pgEnum('plan_type', PLAN_TYPES);
export const inviteStatusEnum = pgEnum('invite_status', ['PENDING', 'ACCEPTED', 'EXPIRED', 'REVOKED']);
export const tokenPurposeEnum = pgEnum('token_purpose', ['EMAIL_VERIFICATION', 'PASSWORD_RESET']);

/** Add a value here (ALTER TYPE ... ADD VALUE) when you implement a new provider. */
export const channelProviderEnum = pgEnum('channel_provider', [
  'WHATSAPP',
  'TELEGRAM',
  'INSTAGRAM',
  'FACEBOOK_PAGE',
  'TIKTOK',
  'X',
  'LINKEDIN',
]);
export const channelStatusEnum = pgEnum('channel_status', [
  'PENDING',
  'CONNECTING',
  'AWAITING_AUTH', // WhatsApp pairing, or an OAuth consent screen for other providers
  'CONNECTED',
  'RECONNECTING',
  'DISCONNECTED',
  'LOGGED_OUT',
  'FAILED',
  'STOPPED',
]);
export const messageDirectionEnum = pgEnum('message_direction', ['INBOUND', 'OUTBOUND']);
export const actorTypeEnum = pgEnum('actor_type', ['USER', 'API_KEY', 'SYSTEM']);

export type PlatformRole = (typeof platformRoleEnum.enumValues)[number];
export type OrgRole = (typeof orgRoleEnum.enumValues)[number];
export type AccountStatus = (typeof accountStatusEnum.enumValues)[number];
export type OrganizationStatus = (typeof organizationStatusEnum.enumValues)[number];
export type ChannelProvider = (typeof channelProviderEnum.enumValues)[number];
export type ChannelStatus = (typeof channelStatusEnum.enumValues)[number];

/* ============================================================================
 * Identity
 * ========================================================================== */

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: varchar('email', { length: 320 }).notNull(),
    /** Null is allowed so SSO-only accounts can exist later. */
    passwordHash: text('password_hash'),
    fullName: varchar('full_name', { length: 255 }).notNull(),
    phoneNumber: varchar('phone_number', { length: 32 }),
    platformRole: platformRoleEnum('platform_role').notNull().default('USER'),
    status: accountStatusEnum('status').notNull().default('PENDING_VERIFICATION'),
    emailVerifiedAt: tz('email_verified_at'),
    lastLoginAt: tz('last_login_at'),
    passwordChangedAt: tz('password_changed_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: tz('deleted_at'),
  },
  (t) => [
    uniqueIndex('users_email_uq').on(t.email),
    check('users_email_lowercase_chk', sql`${t.email} = lower(${t.email})`),
    index('users_status_idx').on(t.status),
  ],
);

/**
 * One row per login (device). `id` is the `sid` claim in the access token.
 * The refresh token is "<id>.<secret>"; only SHA-256(secret) is stored.
 * previousRefreshTokenHash enables safe rotation (reuse detection + short grace window).
 */
export const authSessions = pgTable(
  'auth_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    refreshTokenHash: varchar('refresh_token_hash', { length: 64 }).notNull(),
    previousRefreshTokenHash: varchar('previous_refresh_token_hash', { length: 64 }),
    rotatedAt: tz('rotated_at'),
    ipAddress: varchar('ip_address', { length: 45 }),
    userAgent: text('user_agent'),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }).notNull().defaultNow(),
    /** Absolute lifetime. Idle timeout is enforced from lastUsedAt. */
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: tz('revoked_at'),
    revokedReason: varchar('revoked_reason', { length: 50 }),
    createdAt: createdAt(),
  },
  (t) => [
    index('auth_sessions_user_idx').on(t.userId, t.revokedAt),
    index('auth_sessions_expires_idx').on(t.expiresAt),
  ],
);

/** Single-use, expiring tokens for email verification and password reset (hash only). */
export const verificationTokens = pgTable(
  'verification_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    purpose: tokenPurposeEnum('purpose').notNull(),
    tokenHash: varchar('token_hash', { length: 64 }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: tz('consumed_at'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('verification_tokens_hash_uq').on(t.tokenHash),
    index('verification_tokens_user_purpose_idx').on(t.userId, t.purpose),
  ],
);

/* ============================================================================
 * Tenancy
 * ========================================================================== */

export const organizations = pgTable(
  'organizations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: varchar('name', { length: 255 }).notNull(),
    slug: varchar('slug', { length: 80 }).notNull(),
    planType: planTypeEnum('plan_type').notNull().default('FREE_TRIAL'),
    /** Per-organization overrides of the plan limits, set by a platform admin. */
    limitOverrides: jsonb('limit_overrides').$type<Partial<PlanLimits>>(),
    status: organizationStatusEnum('status').notNull().default('ACTIVE'),
    suspendedAt: tz('suspended_at'),
    suspendedReason: text('suspended_reason'),
    settings: jsonb('settings').$type<Record<string, unknown>>().notNull().default({}),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: tz('deleted_at'),
  },
  (t) => [
    uniqueIndex('organizations_slug_uq').on(t.slug),
    check('organizations_slug_lowercase_chk', sql`${t.slug} = lower(${t.slug})`),
    index('organizations_status_idx').on(t.status),
  ],
);

/**
 * Who belongs to which organization, and with what role.
 * There is no ownerId on organizations: the owner is the member with role OWNER.
 * (An organization must always keep at least one OWNER; the service layer enforces it under a row lock.)
 */
export const organizationMembers = pgTable(
  'organization_members',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: orgRoleEnum('role').notNull().default('MEMBER'),
    status: memberStatusEnum('status').notNull().default('ACTIVE'),
    invitedByUserId: uuid('invited_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('org_members_org_user_uq').on(t.organizationId, t.userId),
    index('org_members_user_idx').on(t.userId),
    index('org_members_org_role_idx').on(t.organizationId, t.role),
  ],
);

export const organizationInvites = pgTable(
  'organization_invites',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    email: varchar('email', { length: 320 }).notNull(),
    role: orgRoleEnum('role').notNull().default('MEMBER'),
    /** SHA-256 of the token that was emailed. The token itself is never stored. */
    tokenHash: varchar('token_hash', { length: 64 }).notNull(),
    status: inviteStatusEnum('status').notNull().default('PENDING'),
    invitedByUserId: uuid('invited_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    acceptedAt: tz('accepted_at'),
    acceptedByUserId: uuid('accepted_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('invites_token_hash_uq').on(t.tokenHash),
    // One live invitation per (organization, email). Prevents invite spam and duplicate seats.
    uniqueIndex('invites_pending_uq')
      .on(t.organizationId, t.email)
      .where(sql`${t.status} = 'PENDING'`),
    index('invites_org_idx').on(t.organizationId),
    check('invites_email_lowercase_chk', sql`${t.email} = lower(${t.email})`),
    // Ownership is transferred, never invited.
    check('invites_role_not_owner_chk', sql`${t.role} <> 'OWNER'`),
  ],
);

export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    name: varchar('name', { length: 255 }).notNull(),
    /** First characters of the key, shown in the UI so people can tell keys apart. */
    prefix: varchar('prefix', { length: 20 }).notNull(),
    keyHash: varchar('key_hash', { length: 64 }).notNull(),
    scopes: jsonb('scopes').$type<string[]>().notNull().default([]),
    lastUsedAt: tz('last_used_at'),
    lastUsedIp: varchar('last_used_ip', { length: 45 }),
    expiresAt: tz('expires_at'),
    revokedAt: tz('revoked_at'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('api_keys_hash_uq').on(t.keyHash), index('api_keys_org_idx').on(t.organizationId)],
);

/* ============================================================================
 * Channels: an organization's connected accounts (WhatsApp today, more later)
 * ========================================================================== */

export const channels = pgTable(
  'channels',
  {
    /** For WhatsApp this is the Baileys sessionId. */
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    provider: channelProviderEnum('provider').notNull(),
    displayName: varchar('display_name', { length: 255 }).notNull(),
    /** Identity at the provider: phone number (WhatsApp), page id, bot id, ... */
    externalId: varchar('external_id', { length: 255 }),
    status: channelStatusEnum('status').notNull().default('PENDING'),
    statusReason: text('status_reason'),
    /** Non-secret, provider-specific facts (WhatsApp jid/lid/name, page category, ...). */
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    /** Per-channel automation settings (rate limits, quiet hours, ...). */
    settings: jsonb('settings').$type<Record<string, unknown>>().notNull().default({}),
    /** When this number first came online. Account age decides how many messages per day are safe. */
    firstConnectedAt: tz('first_connected_at'),
    lastConnectedAt: tz('last_connected_at'),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: tz('deleted_at'),
  },
  (t) => [
    index('channels_org_provider_idx').on(t.organizationId, t.provider),
    index('channels_status_idx').on(t.status),
    // One real-world account can only be connected in one organization at a time.
    uniqueIndex('channels_provider_external_uq')
      .on(t.provider, t.externalId)
      .where(sql`${t.externalId} is not null and ${t.deletedAt} is null`),
  ],
);

/**
 * Secrets for a channel (Baileys auth state, OAuth access/refresh tokens), encrypted with AES-256-GCM.
 * Kept in its own table so a normal `select * from channels` can never leak them.
 */
export const channelCredentials = pgTable('channel_credentials', {
  channelId: uuid('channel_id')
    .primaryKey()
    .references(() => channels.id, { onDelete: 'cascade' }),
  encryptedPayload: text('encrypted_payload').notNull(),
  /** Which encryption key encrypted this row, so keys can be rotated. */
  keyVersion: integer('key_version').notNull().default(1),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const messageKindEnum = pgEnum('message_kind', ['TEXT', 'IMAGE', 'STICKER', 'STATUS_TEXT', 'STATUS_IMAGE']);
export const deliveryStatusEnum = pgEnum('delivery_status', [
  'QUEUED',
  'SENDING',
  'SENT',
  'FAILED',
  'CANCELLED',
  'RECEIVED',
]);
/** AUTO_REPLY is reserved: the type exists so rows can be created later without another migration. */
export const automationTypeEnum = pgEnum('automation_type', ['BROADCAST', 'STATUS_POST', 'STATUS_VIEW', 'AUTO_REPLY']);

/** Saved messages: reusable text (with WhatsApp formatting preserved exactly) that automations send. */
export const messageTemplates = pgTable(
  'message_templates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 100 }).notNull(),
    /** Raw text exactly as written: *bold*, _italic_, ~strike~, ```blocks```, links, @mentions. */
    body: text('body').notNull(),
    /** Alternative wordings. One is picked at random per send, so identical text is not blasted to many chats. */
    variants: jsonb('variants').$type<string[]>().notNull().default([]),
    /** Optional image (https URL, fetched safely at send time). The body then becomes its caption. */
    mediaUrl: text('media_url'),
    entities: jsonb('entities').$type<FormatEntity[]>().notNull().default([]),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: tz('deleted_at'),
  },
  (t) => [
    uniqueIndex('message_templates_org_name_uq')
      .on(t.organizationId, t.name)
      .where(sql`${t.deletedAt} is null`),
  ],
);

/** Things the system does for a channel by itself. `config` is validated per type with Zod. */
export const automations = pgTable(
  'automations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 100 }).notNull(),
    type: automationTypeEnum('type').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    config: jsonb('config').$type<Record<string, unknown>>().notNull(),
    nextRunAt: tz('next_run_at'),
    lastRunAt: tz('last_run_at'),
    runCount: integer('run_count').notNull().default(0),
    lastError: text('last_error'),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: tz('deleted_at'),
  },
  (t) => [
    // The scheduler's only hot query.
    index('automations_due_idx').on(t.enabled, t.nextRunAt),
    index('automations_channel_idx').on(t.channelId),
    // One "view statuses" policy per channel.
    uniqueIndex('automations_status_view_uq')
      .on(t.channelId)
      .where(sql`${t.type} = 'STATUS_VIEW' and ${t.deletedAt} is null`),
  ],
);

/**
 * Every message in or out, for every provider. Outbound rows are created when a message is QUEUED
 * (so its progress can be followed and it can be cancelled) and updated as it is sent.
 */
export const channelMessages = pgTable(
  'channel_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    /** Null until the provider confirms the send. */
    externalMessageId: varchar('external_message_id', { length: 255 }),
    direction: messageDirectionEnum('direction').notNull(),
    kind: messageKindEnum('kind').notNull().default('TEXT'),
    deliveryStatus: deliveryStatusEnum('delivery_status').notNull().default('RECEIVED'),
    fromAddress: varchar('from_address', { length: 255 }).notNull(),
    toAddress: varchar('to_address', { length: 255 }).notNull(),
    /** Raw text, lossless: formatting markers, emoji and line breaks exactly as WhatsApp carries them. */
    content: text('content'),
    /** Parsed formatting spans over `content`, for search, analytics and rendering. */
    entities: jsonb('entities').$type<FormatEntity[]>().notNull().default([]),
    links: jsonb('links').$type<string[]>().notNull().default([]),
    mentions: jsonb('mentions').$type<string[]>().notNull().default([]),
    media: jsonb('media').$type<MessageMedia>(),
    /** Extras for queued sends (status audience, colours). */
    payload: jsonb('payload').$type<OutboundPayload>(),
    /** Lets a client retry a request safely: the same key never creates a second message. */
    idempotencyKey: varchar('idempotency_key', { length: 128 }),
    automationId: uuid('automation_id').references(() => automations.id, { onDelete: 'set null' }),
    scheduledFor: tz('scheduled_for'),
    sentAt: tz('sent_at'),
    attempts: integer('attempts').notNull().default(0),
    failureReason: text('failure_reason'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('channel_messages_channel_ext_uq').on(t.channelId, t.externalMessageId),
    uniqueIndex('channel_messages_idempotency_uq')
      .on(t.channelId, t.idempotencyKey)
      .where(sql`${t.idempotencyKey} is not null`),
    index('channel_messages_org_created_idx').on(t.organizationId, t.createdAt),
    index('channel_messages_channel_created_idx').on(t.channelId, t.createdAt),
    index('channel_messages_queue_idx').on(t.channelId, t.deliveryStatus),
    index('channel_messages_peer_idx').on(t.channelId, t.fromAddress),
  ],
);

/** People who asked to stop. Checked before every send; never overridden by an automation. */
export const channelOptOuts = pgTable(
  'channel_opt_outs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    address: varchar('address', { length: 255 }).notNull(),
    reason: varchar('reason', { length: 50 }).notNull().default('KEYWORD'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('channel_opt_outs_channel_address_uq').on(t.channelId, t.address)],
);

export type MessageKind = (typeof messageKindEnum.enumValues)[number];
export type DeliveryStatus = (typeof deliveryStatusEnum.enumValues)[number];
export type AutomationType = (typeof automationTypeEnum.enumValues)[number];
export type MessageTemplate = typeof messageTemplates.$inferSelect;
export type Automation = typeof automations.$inferSelect;
export type ChannelMessage = typeof channelMessages.$inferSelect;

/* ============================================================================
 * Audit (append-only: grant the app role INSERT and SELECT only on this table)
 * ========================================================================== */

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Null for platform-level actions. SET NULL keeps the log when an organization is purged. */
    organizationId: uuid('organization_id').references(() => organizations.id, { onDelete: 'set null' }),
    actorType: actorTypeEnum('actor_type').notNull().default('USER'),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    /** Dotted verb, e.g. member.role_changed, channel.created, admin.organization_suspended. */
    action: varchar('action', { length: 100 }).notNull(),
    targetType: varchar('target_type', { length: 50 }),
    targetId: varchar('target_id', { length: 100 }),
    /** Never put secrets, tokens or message content here. */
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    ipAddress: varchar('ip_address', { length: 45 }),
    userAgent: text('user_agent'),
    requestId: varchar('request_id', { length: 64 }),
    createdAt: createdAt(),
  },
  (t) => [
    index('audit_logs_org_created_idx').on(t.organizationId, t.createdAt),
    index('audit_logs_actor_created_idx').on(t.actorUserId, t.createdAt),
    index('audit_logs_action_idx').on(t.action),
  ],
);

/* ============================================================================
 * Relations (only the ones the code queries through db.query)
 * ========================================================================== */

export const usersRelations = relations(users, ({ many }) => ({
  memberships: many(organizationMembers),
  authSessions: many(authSessions),
}));

export const authSessionsRelations = relations(authSessions, ({ one }) => ({
  user: one(users, { fields: [authSessions.userId], references: [users.id] }),
}));

export const verificationTokensRelations = relations(verificationTokens, ({ one }) => ({
  user: one(users, { fields: [verificationTokens.userId], references: [users.id] }),
}));

export const organizationsRelations = relations(organizations, ({ many }) => ({
  members: many(organizationMembers),
  invites: many(organizationInvites),
  apiKeys: many(apiKeys),
  channels: many(channels),
}));

export const organizationMembersRelations = relations(organizationMembers, ({ one }) => ({
  organization: one(organizations, { fields: [organizationMembers.organizationId], references: [organizations.id] }),
  user: one(users, { fields: [organizationMembers.userId], references: [users.id] }),
}));

export const organizationInvitesRelations = relations(organizationInvites, ({ one }) => ({
  organization: one(organizations, { fields: [organizationInvites.organizationId], references: [organizations.id] }),
}));

export const apiKeysRelations = relations(apiKeys, ({ one }) => ({
  organization: one(organizations, { fields: [apiKeys.organizationId], references: [organizations.id] }),
}));

export const channelsRelations = relations(channels, ({ one, many }) => ({
  organization: one(organizations, { fields: [channels.organizationId], references: [organizations.id] }),
  credentials: one(channelCredentials, { fields: [channels.id], references: [channelCredentials.channelId] }),
  messages: many(channelMessages),
}));

export const channelCredentialsRelations = relations(channelCredentials, ({ one }) => ({
  channel: one(channels, { fields: [channelCredentials.channelId], references: [channels.id] }),
}));

export const channelMessagesRelations = relations(channelMessages, ({ one }) => ({
  channel: one(channels, { fields: [channelMessages.channelId], references: [channels.id] }),
}));

export type User = typeof users.$inferSelect;
export type Organization = typeof organizations.$inferSelect;
export type OrganizationMember = typeof organizationMembers.$inferSelect;
export type OrganizationInvite = typeof organizationInvites.$inferSelect;
export type Channel = typeof channels.$inferSelect;