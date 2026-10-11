// path: src/utils/security.util.ts

import { redis } from '../config/redis.js';

/**
 * Enterprise Security Engine for IP Blacklisting and Threat Tracking using Redis.
 */
export class SecurityEngine {
  private static readonly BLACKLIST_PREFIX = 'sec:blacklist:ip:';
  private static readonly NOT_FOUND_PREFIX = 'sec:404:ip:';

  /**
   * Immediately blacklists a target IP address in Redis.
   *
   * @param ip - Client IP address to be banned
   * @param durationInSeconds - Ban duration in seconds (Default: 86400 / 24 Hours)
   * @param reason - Internal log reason for the ban
   */
  public static async blacklistIp(
    ip: string,
    durationInSeconds: number = 86400,
    reason: string = 'SUSPICIOUS_ACTIVITY'
  ): Promise<void> {
    const key = `${this.BLACKLIST_PREFIX}${ip}`;
    await redis.set(key, JSON.stringify({ bannedAt: new Date().toISOString(), reason }), 'EX', durationInSeconds);
    console.warn(`🚨 [SECURITY ALERT]: IP ${ip} has been BLACKLISTED for ${durationInSeconds}s. Reason: ${reason}`);
  }

  /**
   * Checks whether the specified IP address is currently blacklisted.
   *
   * @param ip - Client IP address to evaluate
   * @returns Boolean indicating ban status
   */
  public static async isIpBlacklisted(ip: string): Promise<boolean> {
    const key = `${this.BLACKLIST_PREFIX}${ip}`;
    const exists = await redis.exists(key);
    return exists === 1;
  }

  /**
   * Tracks 404 Not Found attempts for an IP. Automatically blacklists IP if threshold is breached.
   *
   * @param ip - Client IP address
   * @param maxNotFound - Maximum allowed 404s within the window (Default: 5)
   * @param windowInSeconds - Time frame window in seconds (Default: 60)
   * @param banDurationInSeconds - Ban duration if threshold breached (Default: 86400)
   */
  public static async recordNotFound(
    ip: string,
    maxNotFound: number = 5,
    windowInSeconds: number = 60,
    banDurationInSeconds: number = 86400
  ): Promise<void> {
    const key = `${this.NOT_FOUND_PREFIX}${ip}`;
    const count = await redis.incr(key);

    if (count === 1) {
      await redis.expire(key, windowInSeconds);
    }

    if (count >= maxNotFound) {
      await this.blacklistIp(
        ip,
        banDurationInSeconds,
        `EXCEEDED_${maxNotFound}_NOT_FOUND_RESPONSES_IN_${windowInSeconds}S`
      );
      await redis.del(key);
    }
  }
}