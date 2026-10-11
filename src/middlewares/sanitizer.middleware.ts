// path: src/middlewares/sanitizer.middleware.ts

import type { Request, Response, NextFunction } from 'express';
import { Sanitizer } from '../utils/sanitizer.util.js';

/**
 * Express Middleware that intercepts incoming requests and sanitizes body, query, and path parameters
 * to prevent Cross-Site Scripting (XSS) and NoSQL Injection attacks.
 */
export const sanitizeInput = (req: Request, _res: Response, next: NextFunction): void => {
  try {
    if (req.body) {
      req.body = Sanitizer.sanitizePayload(req.body);
    }

    if (req.query) {
      req.query = Sanitizer.sanitizePayload(req.query);
    }

    if (req.params) {
      req.params = Sanitizer.sanitizePayload(req.params);
    }

    next();
  } catch (error) {
    next(error);
  }
};