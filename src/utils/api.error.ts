import { StatusCodes, type HttpStatusCode } from '../constants/status-codes.js';

/**
 * Enterprise Custom Application Error Class.
 * Extends native Node.js Error to carry HTTP Status Codes, domain error codes, and operational flags.
 *
 * @example
 * ```typescript
 * throw new ApiError(StatusCodes.NOT_FOUND, 'User session not found', 'SESSION_NOT_FOUND');
 * ```
 */
export class ApiError extends Error {
  public readonly statusCode: HttpStatusCode;
  public readonly errorCode: string;
  public readonly details: unknown;
  public readonly isOperational: boolean;

  /**
   * Constructs a new ApiError instance.
   *
   * @param statusCode - HTTP Status Code from {@link StatusCodes}
   * @param message - Human-readable error description
   * @param errorCode - Application specific code for programmatic tracking (Default: 'BAD_REQUEST' or 'INTERNAL_ERROR')
   * @param details - Extra payload (e.g. validation issue array or stack objects)
   * @param isOperational - Indicates if error is operational (trusted) or programming crash error
   */
  constructor(
    statusCode: HttpStatusCode = StatusCodes.INTERNAL_SERVER_ERROR,
    message: string = 'An unexpected error occurred',
    errorCode?: string,
    details: unknown = null,
    isOperational: boolean = true
  ) {
    super(message);

    // Restore prototype chain for instance checks
    Object.setPrototypeOf(this, new.target.prototype);

    this.statusCode = statusCode;
    this.errorCode = errorCode ?? (statusCode >= 500 ? 'INTERNAL_SERVER_ERROR' : 'BAD_REQUEST');
    this.details = details;
    this.isOperational = isOperational;

    // Capture stack trace for precise error tracking
    Error.captureStackTrace(this, this.constructor);
  }

  // Common static factory shortcuts
  public static badRequest(message: string, errorCode: string = 'BAD_REQUEST', details?: unknown): ApiError {
    return new ApiError(StatusCodes.BAD_REQUEST, message, errorCode, details);
  }

  public static unauthorized(message: string = 'Unauthorized access', errorCode: string = 'UNAUTHORIZED'): ApiError {
    return new ApiError(StatusCodes.UNAUTHORIZED, message, errorCode);
  }

  public static forbidden(message: string = 'Access forbidden', errorCode: string = 'FORBIDDEN'): ApiError {
    return new ApiError(StatusCodes.FORBIDDEN, message, errorCode);
  }

  public static notFound(message: string = 'Resource not found', errorCode: string = 'NOT_FOUND'): ApiError {
    return new ApiError(StatusCodes.NOT_FOUND, message, errorCode);
  }

  public static internal(message: string = 'Internal server error', errorCode: string = 'INTERNAL_ERROR'): ApiError {
    return new ApiError(StatusCodes.INTERNAL_SERVER_ERROR, message, errorCode, null, false);
  }
}