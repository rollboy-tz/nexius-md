import type { Request, Response, NextFunction, ErrorRequestHandler } from 'express';
import { Prisma } from '@prisma/client';
import { ZodError } from 'zod';
import type { Boom } from '@hapi/boom';
import { ApiError } from '../utils/api.error.js';
import { StatusCodes, type HttpStatusCode } from '../constants/status-codes.js';
import { ApiResponse } from '../utils/api-response.util.js';
import { env } from '../config/env.js';

/**
 * Representational structure for formatted stack frame elements.
 */
export interface FormattedStackFrame {
  /** Method or function identifier executing when exception occurred */
  readonly method: string;
  /** Relative or absolute file path reference */
  readonly file: string;
  /** Exact line and column location within source file */
  readonly line: string;
}

/**
 * Interface representing structured error field details from validation failures.
 */
export interface ValidationErrorDetail {
  /** Targeted path or property key failing validation */
  readonly field: string;
  /** Human readable explanation of validation requirement */
  readonly message: string;
  /** Internal error rule or code */
  readonly rule: string;
}

/**
 * Parses and formats raw error stack trace string into structured debug object array.
 *
 * @param stack - Raw Error stack trace string
 * @returns Array of structured {@link FormattedStackFrame} items
 */
function parseStackTrace(stack?: string): FormattedStackFrame[] {
  if (!stack) return [];

  return stack
    .split('\n')
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('at '))
    .map((line) => {
      const sanitized = line.replace(/^at\s+/, '');
      const match = sanitized.match(/(?:(.+?)\s+\()?(?:(.+?):(\d+):(\d+))\)?$/);

      if (!match) {
        return { method: 'unknown', file: sanitized, line: '0' };
      }

      return {
        method: match[1] || 'anonymous',
        file: match[2] || 'unknown',
        line: `${match[3]}:${match[4]}`
      };
    })
    .slice(0, 10);
}

/**
 * Redacts confidential properties, secrets, and connection credentials from debug output.
 *
 * @param data - Target payload intended for sanitization
 * @returns Deeply sanitized clone of input object
 */
function sanitizeSensitiveData(data: unknown): unknown {
  if (!data || typeof data !== 'object') return data;

  const SENSITIVE_KEYS = [
    'password',
    'token',
    'authorization',
    'secret',
    'apikey',
    'cookie',
    'session',
    'db_url',
    'database_url'
  ];

  if (Array.isArray(data)) {
    return data.map(sanitizeSensitiveData);
  }

  const sanitizedObj: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    const isSensitive = SENSITIVE_KEYS.some((sensitiveKey) =>
      key.toLowerCase().includes(sensitiveKey)
    );

    if (isSensitive) {
      sanitizedObj[key] = '[REDACTED_SENSITIVE_DATA]';
    } else if (typeof value === 'object' && value !== null) {
      sanitizedObj[key] = sanitizeSensitiveData(value);
    } else {
      sanitizedObj[key] = value;
    }
  }

  return sanitizedObj;
}

/**
 * Logs exception execution metadata cleanly to terminal output.
 *
 * @param err - Exception instance captured
 * @param req - Express Request instance
 * @param errorCode - Application specific tracking code
 * @param statusCode - Resolved HTTP Status Code
 */
function logErrorDetails(
  err: Error,
  req: Request,
  errorCode: string,
  statusCode: HttpStatusCode
): void {
  const timestamp = new Date().toISOString();
  const method = req.method;
  const path = req.originalUrl;
  const ip = req.ip || req.socket.remoteAddress || 'unknown';

  console.error(`\n=================== 💥 [ERROR LOGGED] ===================`);
  console.error(`📅 Timestamp : ${timestamp}`);
  console.error(`🌐 Request   : ${method} ${path} (Client IP: ${ip})`);
  console.error(`🏷️  ErrorCode : ${errorCode} (HTTP ${statusCode})`);
  console.error(`💬 Message   : ${err.message}`);

  if (env.NODE_ENV === 'development' && err.stack) {
    console.error(`📌 Stack Trace Preview:`);
    console.error(err.stack);
  }
  console.error(`=========================================================\n`);
}

/**
 * Safely resolves unknown numerical HTTP status code into a valid type-safe {@link HttpStatusCode}.
 *
 * @param code - Raw numeric status code candidate
 * @param fallback - Default status code if input doesn't match standard HTTP specs
 * @returns Strict {@link HttpStatusCode} enum value
 */
function resolveHttpStatusCode(code?: number, fallback: HttpStatusCode = StatusCodes.INTERNAL_SERVER_ERROR): HttpStatusCode {
  if (!code) return fallback;
  const validCodes = Object.values(StatusCodes) as number[];
  return validCodes.includes(code) ? (code as HttpStatusCode) : fallback;
}

/**
 * Enterprise Global Error Handling Middleware.
 * Intercepts all thrown exceptions, normalizes validation, database, and socket errors,
 * enforces strict type-safety, and dispatches uniform JSON API error envelopes.
 *
 * @param err - Thrown error or exception payload
 * @param req - Incoming Express Request object
 * @param res - Outgoing Express Response object
 * @param _next - Express Next Function reference
 */
export const globalErrorHandler: ErrorRequestHandler = (
  err: Error,
  req: Request,
  res: Response,
  _next: NextFunction
): void => {
  let statusCode: HttpStatusCode = StatusCodes.INTERNAL_SERVER_ERROR;
  let errorCode: string = 'INTERNAL_SERVER_ERROR';
  let message: string = 'An unexpected internal server error occurred';
  let details: unknown = null;

  // -------------------------------------------------------------------
  // 1. Domain Application ApiErrors
  // -------------------------------------------------------------------
  if (err instanceof ApiError) {
    statusCode = err.statusCode;
    errorCode = err.errorCode;
    message = err.message;
    details = err.details;
  }

  // -------------------------------------------------------------------
  // 2. Zod Validation Errors
  // -------------------------------------------------------------------
  else if (err instanceof ZodError) {
    statusCode = StatusCodes.UNPROCESSABLE_ENTITY;
    errorCode = 'VALIDATION_ERROR';
    message = 'Input payload validation failed';
    
    const validationDetails: ValidationErrorDetail[] = err.issues.map((issue) => ({
      field: issue.path.join('.'),
      message: issue.message,
      rule: issue.code
    }));

    details = validationDetails;
  }

  // -------------------------------------------------------------------
  // 3. Prisma Database ORM Errors
  // -------------------------------------------------------------------
  else if (err instanceof Prisma.PrismaClientKnownRequestError) {
    switch (err.code) {
      case 'P2002': {
        const targetFields = (err.meta?.target as string[]) || ['field'];
        statusCode = StatusCodes.CONFLICT;
        errorCode = 'DUPLICATE_ENTRY';
        message = `A record with this ${targetFields.join(', ')} already exists.`;
        details = { duplicateFields: targetFields };
        break;
      }
      case 'P2025': {
        statusCode = StatusCodes.NOT_FOUND;
        errorCode = 'RECORD_NOT_FOUND';
        message = 'The requested database record was not found or was already deleted.';
        break;
      }
      case 'P2003': {
        statusCode = StatusCodes.BAD_REQUEST;
        errorCode = 'FOREIGN_KEY_CONSTRAINT_FAILED';
        message = 'Invalid reference identifier provided for related database resource.';
        break;
      }
      default: {
        statusCode = StatusCodes.BAD_REQUEST;
        errorCode = `DATABASE_ERROR_${err.code}`;
        message = 'A database constraint violation occurred.';
        details = env.NODE_ENV === 'development' ? { prismaMeta: err.meta } : null;
        break;
      }
    }
  } else if (err instanceof Prisma.PrismaClientValidationError) {
    statusCode = StatusCodes.BAD_REQUEST;
    errorCode = 'DATABASE_VALIDATION_ERROR';
    message = 'Invalid query parameters or structural schema mismatch passed to database client.';
  } else if (err instanceof Prisma.PrismaClientInitializationError) {
    statusCode = StatusCodes.SERVICE_UNAVAILABLE;
    errorCode = 'DATABASE_CONNECTION_FAILED';
    message = 'Unable to establish connection to primary database storage.';
  }

  // -------------------------------------------------------------------
  // 4. Baileys / Boom HTTP Errors (WhatsApp Web Socket)
  // -------------------------------------------------------------------
  else if ('isBoom' in err && (err as Boom).isBoom) {
    const boomErr = err as Boom;
    const rawStatusCode = boomErr.output?.statusCode;
    statusCode = resolveHttpStatusCode(rawStatusCode, StatusCodes.INTERNAL_SERVER_ERROR);
    errorCode = `BAILEYS_SOCKET_ERROR_${statusCode}`;
    message = boomErr.message || 'WhatsApp socket operation failed';
    details = boomErr.output?.payload ?? null;
  }

  // -------------------------------------------------------------------
  // 5. Express Malformed JSON Body Parsing Errors
  // -------------------------------------------------------------------
  else if ('type' in err && (err as { type: string }).type === 'entity.parse.failed') {
    statusCode = StatusCodes.BAD_REQUEST;
    errorCode = 'INVALID_JSON_BODY';
    message = 'Malformed JSON payload received in request body. Please verify JSON syntax.';
  }

  // -------------------------------------------------------------------
  // 6. Native Database Driver Errors (e.g. Postgres / pg)
  // -------------------------------------------------------------------
  else if ('code' in err && typeof (err as { code: unknown }).code === 'string') {
    const pgCode = (err as { code: string }).code;
    if (pgCode === '23505') {
      statusCode = StatusCodes.CONFLICT;
      errorCode = 'PG_UNIQUE_VIOLATION';
      message = 'Duplicate key value violates unique constraint.';
    } else if (pgCode === '28P01') {
      statusCode = StatusCodes.SERVICE_UNAVAILABLE;
      errorCode = 'PG_AUTHENTICATION_FAILED';
      message = 'Database authentication failure.';
    }
  }

  // Log error details internally to console
  logErrorDetails(err, req, errorCode, statusCode);

  // Sanitize sensitive values from response
  const safeDetails = sanitizeSensitiveData(details);

  const errorEnvelopeDetails =
    env.NODE_ENV === 'development'
      ? {
          ...(safeDetails && typeof safeDetails === 'object' ? safeDetails : { info: safeDetails }),
          stack: parseStackTrace(err.stack)
        }
      : safeDetails;

  // Dispatch standardized JSON API response with strict HttpStatusCode type
  ApiResponse.error(res, message, statusCode, errorCode, errorEnvelopeDetails);
};