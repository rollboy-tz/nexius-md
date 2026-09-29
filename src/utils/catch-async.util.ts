import type { Request, Response, NextFunction, RequestHandler } from 'express';

/**
 * Higher-order function wrapping async route handlers to capture unhandled promise rejections
 * and automatically forward them to Express global error handling middleware (`next(err)`).
 * Eliminates repetitive `try-catch` blocks across controllers.
 *
 * @param fn - Async Express controller/handler function
 * @returns Standard Express {@link RequestHandler}
 *
 * @example
 * ```typescript
 * export const getSession = catchAsync(async (req, res) => {
 *   const session = await prisma.session.findUniqueOrThrow({ where: { id: req.params.id } });
 *   return ResponseUtil.success(res, 'Session found', session);
 * });
 * ```
 */
export const catchAsync = (
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>
): RequestHandler => {
  return (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res, next).catch(next);
  };
};