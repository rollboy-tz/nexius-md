// path: src/middlewares/validate-request.middleware.ts

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { ZodType } from 'zod';
import { ApiError } from '../utils/api.error.js';

/** One schema per part of the request. Anything omitted is not checked. */
export interface RequestSchema {
  body?: ZodType;
  params?: ZodType;
  query?: ZodType;
}

const MAX_REPORTED_ISSUES = 10;

/**
 * Validates a request against Zod schemas BEFORE any handler runs, and replaces the raw input with
 * the parsed result: values are trimmed/normalised, and (with `.strict()` schemas) unknown fields are
 * rejected instead of silently reaching the service layer.
 *
 * Use it AFTER authenticate/requireOrganization, so anonymous callers cannot spend validation work.
 * Read the typed result in controllers with `bodyOf<T>(req)` where T = z.infer<typeof schema.body>.
 */
export const validate =
  (schema: RequestSchema): RequestHandler =>
  (req: Request, _res: Response, next: NextFunction) => {
    try {
      const issues: Array<{ field: string; message: string }> = [];

      const check = (part: 'body' | 'params' | 'query', zodSchema: ZodType | undefined): unknown => {
        if (!zodSchema) return undefined;

        const result = zodSchema.safeParse(req[part]);
        if (result.success) return result.data;

        for (const issue of result.error.issues) {
          issues.push({ field: [part, ...issue.path].join('.'), message: issue.message });
        }
        return undefined;
      };

      const body = check('body', schema.body);
      const params = check('params', schema.params);
      const query = check('query', schema.query);

      if (issues.length > 0) {
        const shown = issues.slice(0, MAX_REPORTED_ISSUES);
        const first = shown[0];

        // `details` is picked up by an error handler that serialises it; harmless if yours does not.
        throw Object.assign(
          ApiError.badRequest(first ? `${first.field}: ${first.message}` : 'Validation failed.', 'VALIDATION_ERROR'),
          { details: shown },
        );
      }

      if (schema.body) req.body = body;
      if (schema.params) req.params = params as Request['params'];
      // Express 5 makes req.query a read-only getter, so it is redefined rather than assigned.
      if (schema.query) Object.defineProperty(req, 'query', { value: query, writable: true, configurable: true });

      next();
    } catch (error) {
      next(error);
    }
  };

/** Typed read of a body the `validate` middleware already checked. T comes from z.infer of that schema. */
export function bodyOf<T>(req: Request): T {
  return req.body as T;
}

export function paramsOf<T>(req: Request): T {
  return req.params as T;
}

export function queryOf<T>(req: Request): T {
  return req.query as T;
}