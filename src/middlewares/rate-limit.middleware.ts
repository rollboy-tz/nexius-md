// path: src/middlewares/rate-limit.middleware.ts

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { redis } from '../config/redis.js';
import { StatusCodes } from '../constants/status-codes.js';
import { ApiError } from '../utils/api.error.js';

export interface RateLimitOptions {
  /** Part of the Redis key, so each limiter counts on its own ("login", "register", ...). */
  name: string;
  limit: number;
  windowSeconds: number;
  /** What to count by. Defaults to the client IP (set `trust proxy` so that is the real client). */
  keyBy?: (req: Request) => string;
}

/** INCR and EXPIRE in one atomic step: a crash between the two can never leave a counter without an expiry. */
const INCREMENT_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return count
`;

export const rateLimit =
  (options: RateLimitOptions): RequestHandler =>
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const subject = options.keyBy?.(req) ?? req.ip ?? 'unknown';
      const key = `rl:${options.name}:${subject}`;

      const count = Number(await redis.eval(INCREMENT_SCRIPT, 1, key, options.windowSeconds));

      res.setHeader('RateLimit-Limit', String(options.limit));
      res.setHeader('RateLimit-Remaining', String(Math.max(0, options.limit - count)));

      if (count > options.limit) {
        const ttl = await redis.ttl(key);
        res.setHeader('Retry-After', String(Math.max(1, ttl)));

        throw new ApiError(StatusCodes.TOO_MANY_REQUESTS, 'Too many requests. Please slow down.', 'RATE_LIMITED');
      }

      next();
    } catch (error) {
      next(error);
    }
  };