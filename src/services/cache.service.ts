// path: src/services/cache.service.ts

import { redis } from '../config/redis.js';

/**
 * High-performance, fail-safe generic caching engine backed by Redis.
 * Designed to serve as a shared caching layer across all Nexius core services.
 */
export class CacheService {
  /**
   * Retrieves and deserializes a JSON payload from Redis.
   * Returns null if key does not exist or if parsing fails (fail-safe).
   *
   * @template T Expected deserialized return payload type
   * @param key Redis storage key
   */
  public static async get<T>(key: string): Promise<T | null> {
    try {
      const data = await redis.get(key);
      if (!data) return null;
      return JSON.parse(data) as T;
    } catch (error) {
      console.error(`❌ [CacheService Exception GET] Key: ${key}`, error);
      return null;
    }
  }

  /**
   * Serializes and persists a value into Redis with a defined TTL.
   *
   * @template T Payload type
   * @param key Redis storage key
   * @param value Target payload to cache
   * @param ttlInSeconds Time-to-live expiration in seconds
   */
  public static async set<T>(key: string, value: T, ttlInSeconds: number): Promise<void> {
    try {
      const serialized = JSON.stringify(value);
      await redis.set(key, serialized, 'EX', ttlInSeconds);
    } catch (error) {
      console.error(`❌ [CacheService Exception SET] Key: ${key}`, error);
    }
  }

  /**
   * Instantly purges one or multiple keys from Redis.
   *
   * @param keys Single key or array of keys to delete
   */
  public static async del(keys: string | string[]): Promise<void> {
    try {
      const targetKeys = Array.isArray(keys) ? keys : [keys];
      if (targetKeys.length === 0) return;
      await redis.del(...targetKeys);
    } catch (error) {
      console.error(`❌ [CacheService Exception DEL] Keys:`, keys, error);
    }
  }

  /**
   * Scans and purges keys matching a specific pattern (e.g., `user:session:*`).
   * Uses SCAN instead of KEYS to prevent blocking the Redis event loop.
   *
   * @param pattern Glob pattern string
   */
  public static async delByPattern(pattern: string): Promise<void> {
    try {
      const stream = redis.scanStream({ match: pattern, count: 100 });
      stream.on('data', (resultKeys: string[]) => {
        if (resultKeys.length > 0) {
          redis.del(...resultKeys);
        }
      });
    } catch (error) {
      console.error(`❌ [CacheService Exception DEL_PATTERN] Pattern: ${pattern}`, error);
    }
  }

  /**
   * Atomic Fetch-or-Compute pattern (Cache-Aside Pattern with Fallback).
   * Executes database query only if cache miss occurs.
   *
   * @template T Target dataset model
   * @param key Redis cache key
   * @param ttlInSeconds Expiration window
   * @param fetcher Async function retrieving data from DB if cache misses
   */
  public static async remember<T>(
    key: string,
    ttlInSeconds: number,
    fetcher: () => Promise<T | null>
  ): Promise<T | null> {
    const cached = await this.get<T>(key);
    if (cached) return cached;

    const freshData = await fetcher();
    if (freshData !== null && freshData !== undefined) {
      await this.set(key, freshData, ttlInSeconds);
    }

    return freshData;
  }
}