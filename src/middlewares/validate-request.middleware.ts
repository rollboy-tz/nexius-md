import type { Request, Response, NextFunction } from 'express';
import type { AnyZodObject, ZodError } from 'zod';

/**
 * Generic Express Middleware enforcing runtime schema validation for Express requests.
 * Parses `req.body`, `req.query`, and `req.params` against supplied Zod schemas.
 *
 * @param schema - Target Zod Schema definition
 */
export const validateRequest = (schema: AnyZodObject) => {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = await schema.parseAsync({
        body: req.body,
        query: req.query,
        params: req.params
      });

      // Assign parsed, typed, and sanitized values back to request
      req.body = parsed.body;
      req.query = parsed.query;
      req.params = parsed.params;

      next();
    } catch (error) {
      // Forward ZodError directly to globalErrorHandler
      next(error);
    }
  };
};