// path: src/middlewares/ip-guard.middleware.ts

import type { Request, Response, NextFunction } from 'express';
import { SecurityEngine } from '../utils/security.util.js';
import { ApiError } from '../utils/api.error.js';

/**
 * Global IP Guard Middleware.
 * Intercepts incoming requests and blocks blacklisted IPs before reaching any application route.
 */
export const ipGuard = async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
  try {
    const clientIp = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip || 'unknown_ip';

    const isBanned = await SecurityEngine.isIpBlacklisted(clientIp);

    if (isBanned) {
      throw ApiError.forbidden('Access denied dues to security violations.', 'IP_BLACK_LISTED');
    }

    next();
  } catch (error) {
    next(error);
  }
};