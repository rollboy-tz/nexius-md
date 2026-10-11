export const PLAN_TYPES = ['FREE_TRIAL', 'STARTER', 'PRO', 'ENTERPRISE'] as const;
export type PlanType = (typeof PLAN_TYPES)[number];

export interface PlanLimits {
  /** Connected accounts (WhatsApp numbers today, other social accounts later). */
  maxChannels: number;
  /** Members plus pending invitations. */
  maxMembers: number;
  maxApiKeys: number;
  messagesPerDay: number;
}

/** Illustrative numbers. Set your real pricing here; nothing else in the code hard-codes a limit. */
export const PLAN_LIMITS: Record<PlanType, PlanLimits> = {
  FREE_TRIAL: { maxChannels: 1, maxMembers: 2, maxApiKeys: 1, messagesPerDay: 200 },
  STARTER: { maxChannels: 3, maxMembers: 5, maxApiKeys: 3, messagesPerDay: 2_000 },
  PRO: { maxChannels: 10, maxMembers: 25, maxApiKeys: 10, messagesPerDay: 20_000 },
  ENTERPRISE: { maxChannels: 100, maxMembers: 500, maxApiKeys: 100, messagesPerDay: 500_000 },
};

/** Plan defaults, overridden per organization by a platform admin (custom deals, support gestures). */
export function resolveLimits(plan: PlanType, overrides?: Partial<PlanLimits> | null): PlanLimits {
  return { ...PLAN_LIMITS[plan], ...(overrides ?? {}) };
}