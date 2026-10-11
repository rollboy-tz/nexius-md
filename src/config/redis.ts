// path: src/config/redis.ts

import { Redis, type RedisOptions } from 'ioredis';
import { env } from './env.js';

const redisUrl = env.REDIS_URL || process.env.REDIS_URL;

// Falling back to localhost in production would silently disable every cache, denylist and rate limit.
if (!redisUrl && process.env.NODE_ENV === 'production') {
  throw new Error('REDIS_URL is not set. Refusing to start in production without Redis.');
}

const redisOptions: RedisOptions = {
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
  connectTimeout: 10_000,
  keepAlive: 30_000,
  retryStrategy: (times) => Math.min(times * 100, 3_000),
  // `rediss://` (Upstash, managed Redis) needs TLS.
  tls: redisUrl?.startsWith('rediss://') ? {} : undefined,
};

export const redis = new Redis(redisUrl || 'redis://localhost:6379', redisOptions);

redis.on('ready', () => console.log('⚡ [Redis]: Connected and ready.'));
redis.on('reconnecting', () => console.warn('🔁 [Redis]: Reconnecting...'));
redis.on('error', (error) => console.error('❌ [Redis Error]:', error.message));

/** Call from the graceful shutdown, next to closeDatabase(). */
export async function closeRedis(): Promise<void> {
  try {
    await redis.quit();
  } catch {
    redis.disconnect();
  }
}