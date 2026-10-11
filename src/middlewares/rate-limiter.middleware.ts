// path: src/middlewares/rate-limiter.middleware.ts

import type { Request, Response, NextFunction } from 'express';
import { RateLimiter } from '../utils/rate-limiter.util.js';
import { ApiError } from '../utils/api.error.js';

/**
 * Options for configuring authentication rate limiting middleware.
 */
export interface AuthRateLimiterOptions {
  /** Maximum allowed requests per IP address within the time window. Default: 20 */
  maxIpRequests?: number;
  /** Maximum allowed requests per targeted user identifier/email. Default: 5 */
  maxEmailRequests?: number;
  /** Expiration window duration in seconds. Default: 900 (15 minutes) */
  windowInSeconds?: number;
}

/**
 * Dual-Key Express middleware designed for high-security authentication endpoints.
 * Tracks requests via both Client IP and Email payload to guard against distributed brute-force attacks.
 * Uses generic error handling to prevent user enumeration and information disclosure.
 *
 * @param options - Configurable threshold parameters
 */
export const authRateLimiter = (options?: AuthRateLimiterOptions) => {
  const maxIpRequests = options?.maxIpRequests || 20;
  const maxEmailRequests = options?.maxEmailRequests || 5;
  const windowInSeconds = options?.windowInSeconds || 900;

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const clientIp = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip || 'unknown_ip';
      const email = req.body?.email ? String(req.body.email).toLowerCase().trim() : null;

      // 1. IP-based limit check
      const ipKey = `ip:${clientIp}:${req.path}`;
      const ipResult = await RateLimiter.consume({
        key: ipKey,
        maxRequests: maxIpRequests,
        windowInSeconds,
      });

      // 2. Identifier-based limit check (Guards against IP-rotation proxies)
      let emailResult = null;
      if (email) {
        const emailKey = `email:${email}:${req.path}`;
        emailResult = await RateLimiter.consume({
          key: emailKey,
          maxRequests: maxEmailRequests,
          windowInSeconds,
        });
      }

      // Check if either threshold was breached
      const isBlocked = ipResult.isBlocked || (emailResult ? emailResult.isBlocked : false);

      if (isBlocked) {
        const retryAfter = Math.max(
          ipResult.isBlocked ? ipResult.retryAfter : 0,
          emailResult && emailResult.isBlocked ? emailResult.retryAfter : 0
        );

        res.setHeader('Retry-After', retryAfter);

        // Standardized response omitting sensitive internal trigger details
        throw ApiError.badRequest(
          'Too many requests. Please try again later.',
          'TOO_MANY_REQUESTS',
          { retryAfterSeconds: retryAfter }
        );
      }

      next();
    } catch (error) {
      next(error);
    }
  };
};