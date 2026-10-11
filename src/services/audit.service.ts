import { and, desc, eq, gte, lte } from 'drizzle-orm';
import { db } from '../config/database.js';
import { auditLogs } from '../db/schema.js';
import type { DbExecutor } from '../db/types.js';

export interface RequestMeta {
  ipAddress?: string | undefined;
  userAgent?: string | undefined;
  requestId?: string | undefined;
}

export interface AuditEntry {
  organizationId?: string | null | undefined;
  actorType?: 'USER' | 'API_KEY' | 'SYSTEM' | undefined;
  actorUserId?: string | null | undefined;
  /** Dotted verb, e.g. member.role_changed. */
  action: string;
  targetType?: string | undefined;
  targetId?: string | undefined;
  /** Never put secrets, tokens or message content here. */
  metadata?: Record<string, unknown> | undefined;
  meta?: RequestMeta | undefined;
}

export interface AuditQuery {
  organizationId?: string | undefined;
  actorUserId?: string | undefined;
  action?: string | undefined;
  from?: Date | undefined;
  to?: Date | undefined;
  page?: number | undefined;
  limit?: number | undefined;
}

export class AuditService {
  /**
   * Pass the transaction (`tx`) when the audited change is made in one: the change and its
   * audit record then commit or roll back together.
   */
  public static async record(entry: AuditEntry, executor: DbExecutor = db): Promise<void> {
    await executor.insert(auditLogs).values({
      organizationId: entry.organizationId ?? null,
      actorType: entry.actorType ?? 'USER',
      actorUserId: entry.actorUserId ?? null,
      action: entry.action,
      targetType: entry.targetType ?? null,
      targetId: entry.targetId ?? null,
      metadata: entry.metadata ?? null,
      ipAddress: entry.meta?.ipAddress ?? null,
      userAgent: entry.meta?.userAgent ?? null,
      requestId: entry.meta?.requestId ?? null,
    });
  }

  /** For events outside a transaction (login, logout) where an audit failure should not block the user. */
  public static async recordBestEffort(entry: AuditEntry): Promise<void> {
    try {
      await this.record(entry);
    } catch (error) {
      console.error('❌ [Audit] Could not write audit log:', entry.action, error);
    }
  }

  public static async list(query: AuditQuery) {
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, Math.max(1, query.limit ?? 25));

    const where = and(
      query.organizationId ? eq(auditLogs.organizationId, query.organizationId) : undefined,
      query.actorUserId ? eq(auditLogs.actorUserId, query.actorUserId) : undefined,
      query.action ? eq(auditLogs.action, query.action) : undefined,
      query.from ? gte(auditLogs.createdAt, query.from) : undefined,
      query.to ? lte(auditLogs.createdAt, query.to) : undefined,
    );

    const rows = await db
      .select()
      .from(auditLogs)
      .where(where)
      .orderBy(desc(auditLogs.createdAt))
      .limit(limit)
      .offset((page - 1) * limit);

    return { data: rows, meta: { page, limit } };
  }
}