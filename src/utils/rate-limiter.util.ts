// path: src/utils/rate-limiter.util.ts

import { redis } from '../config/redis.js';
import { ApiError } from './api.error.js';

/**
 * Configuration options for the RateLimiter engine.
 */
export interface RateLimitConfig {
  /** The unique Redis key identifier used to store and track requests. */
  key: string;
  /** Maximum number of allowed requests within the defined time window. */
  maxRequests: number;
  /** Expiration window duration in seconds. */
  windowInSeconds: number;
}

/**
 * Execution evaluation result returned by the RateLimiter engine.
 */
export interface RateLimitResult {
  /** Indicates whether the current request threshold has been exceeded. */
  isBlocked: boolean;
  /** Total maximum requests allowed in the current window. */
  limit: number;
  /** Remaining request quota left in the current window. */
  remaining: number;
  /** Duration in seconds remaining before the rate limit resets. */
  retryAfter: number;
}

/**
 * Enterprise-grade Redis Rate Limiter utilizing atomic Lua scripts
 * to prevent race conditions during high-concurrency requests.
 */
export class RateLimiter {
  /**
   * Atomic Lua script ensuring thread-safe INCR and EXPIRE operations.
   */
  private static readonly LUA_RATE_LIMIT_SCRIPT = `
    local current = redis.call('INCR', KEYS[1])
    if tonumber(current) == 1 then
      redis.call('EXPIRE', KEYS[1], ARGV[1])
    end
    local ttl = redis.call('TTL', KEYS[1])
    return {current, ttl}
  `;

  /**
   * Evaluates request limits and consumes quota atomically within Redis.
   *
   * @param config - Rate limiting configuration properties
   * @returns Evaluation details including quota consumed and expiration status
   */
  public static async consume(config: RateLimitConfig): Promise<RateLimitResult> {
    const { key, maxRequests, windowInSeconds } = config;
    const redisKey = `ratelimit:${key}`;

    try {
      const result = (await redis.eval(
        this.LUA_RATE_LIMIT_SCRIPT,
        1,
        redisKey,
        windowInSeconds
      )) as [number, number];

      const currentRequests = result[0];
      const ttl = result[1];

      const remaining = Math.max(0, maxRequests - currentRequests);
      const retryAfter = ttl > 0 ? ttl : windowInSeconds;
      const isBlocked = currentRequests > maxRequests;

      return {
        isBlocked,
        limit: maxRequests,
        remaining,
        retryAfter,
      };
    } catch (error) {
      // Fail-Open Resilience Strategy: Log Redis issues without blocking legitimate users
      console.error('❌ [RateLimiter Fail-Open Exception]:', error);
      return {
        isBlocked: false,
        limit: maxRequests,
        remaining: 1,
        retryAfter: 0,
      };
    }
  }

  /**
   * Evaluates rate limits and throws a generic ApiError if the limit is exceeded.
   *
   * @param config - Rate limiting configuration properties
   * @throws {@link ApiError} When the allowed request quota is exhausted
   */
  public static async checkAndConsume(config: RateLimitConfig): Promise<RateLimitResult> {
    const result = await this.consume(config);

    if (result.isBlocked) {
      throw ApiError.badRequest(
        'Too many attempts. Please try again later.',
        'TOO_MANY_REQUESTS',
        { retryAfterSeconds: result.retryAfter }
      );
    }

    return result;
  }

  /**
   * Clears the rate limit counter for a specific key (e.g., upon successful authentication).
   *
   * @param key - The unique Redis key identifier
   */
  public static async reset(key: string): Promise<void> {
    try {
      await redis.del(`ratelimit:${key}`);
    } catch (error) {
      console.error('❌ [RateLimiter Reset Exception]:', error);
    }
  }
}