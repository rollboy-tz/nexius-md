// path: src/middlewares/error.middleware.ts

import type { Request, Response, NextFunction, ErrorRequestHandler } from 'express';
import { DrizzleError } from 'drizzle-orm';
import { ZodError } from 'zod';
import type { Boom } from '@hapi/boom';
import { ApiError } from '../utils/api.error.js';
import { StatusCodes, type HttpStatusCode } from '../constants/status-codes.js';
import { ApiResponse } from '../utils/api-response.util.js';
import { env } from '../config/env.js';

/**
 * Structured trace elements representing clean stack frame locations.
 */
export interface FormattedStackFrame {
  /** Executing function or method identifier */
  readonly method: string;
  /** File path relative to process working directory */
  readonly file: string;
  /** Exact line and column reference */
  readonly line: string;
}

/**
 * Standardized response envelope detailing validation failure parameters.
 */
export interface ValidationErrorDetail {
  /** Target schema field path causing the validation error */
  readonly field: string;
  /** Human-readable failure explanation */
  readonly message: string;
  /** Internal Zod validation rule code identifier */
  readonly rule: string;
}

/**
 * Interface representing native driver database error object structures.
 */
interface DatabaseDriverError extends Error {
  code?: string;
  detail?: string;
  constraint?: string;
  table?: string;
  column?: string;
}

/**
 * Converts raw error stack traces into structured objects for clean dev debugging.
 *
 * @param stack - Raw Error stack trace string
 * @returns Array of max 10 parsed {@link FormattedStackFrame} items
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
 * Deeply redacts sensitive keys, tokens, and authorization credentials from error details.
 *
 * @param data - Target payload intended for logging or response dispatch
 * @returns Deeply sanitized clone of input data
 */
function sanitizeSensitiveData(data: unknown): unknown {
  if (!data || typeof data !== 'object') return data;

  const SENSITIVE_KEYS = [
    'password',
    'pass',
    'token',
    'authorization',
    'secret',
    'apikey',
    'key',
    'cookie',
    'session',
    'db_url',
    'database_url',
    'jwt'
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
 * Logs exception execution metadata cleanly to console streams.
 *
 * @param err - Captured Exception instance
 * @param req - Incoming Express Request instance
 * @param errorCode - System tracking error identifier
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
 * Resolves numerical status code candidates into standard {@link HttpStatusCode}.
 *
 * @param code - Numeric HTTP code candidate
 * @param fallback - Default status code fallback
 * @returns Strict {@link HttpStatusCode} enum
 */
function resolveHttpStatusCode(
  code?: number,
  fallback: HttpStatusCode = StatusCodes.INTERNAL_SERVER_ERROR
): HttpStatusCode {
  if (!code) return fallback;
  const validCodes = Object.values(StatusCodes) as number[];
  return validCodes.includes(code) ? (code as HttpStatusCode) : fallback;
}

/**
 * Enterprise Production Global Error Handling Middleware for Express & Drizzle ORM.
 * Catches, normalizes, sanitizes, and dispatches uniform JSON API error envelopes.
 *
 * @param err - Thrown error or exception payload
 * @param req - Express Request instance
 * @param res - Express Response instance
 * @param _next - Express NextFunction reference
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
  // 1. Domain Application Custom ApiErrors
  // -------------------------------------------------------------------
  if (err instanceof ApiError) {
    statusCode = err.statusCode;
    errorCode = err.errorCode;
    message = err.message;
    details = err.details;
  }

  // -------------------------------------------------------------------
  // 2. Zod Payload Validation Failures
  // -------------------------------------------------------------------
  else if (err instanceof ZodError) {
    statusCode = StatusCodes.UNPROCESSABLE_ENTITY;
    errorCode = 'VALIDATION_ERROR';
    message = 'Input payload validation failed';

    const validationDetails: ValidationErrorDetail[] = err.issues.map((issue) => ({
      field: issue.path.join('.').replace(/^(body|query|params)\./, ''),
      message: issue.message,
      rule: issue.code
    }));

    details = validationDetails;
  }

  // -------------------------------------------------------------------
  // 3. PostgreSQL Database Engine & Drizzle ORM Errors
  // -------------------------------------------------------------------
  else if (err instanceof DrizzleError || 'code' in err) {
    const dbErr = err as DatabaseDriverError;

    switch (dbErr.code) {
      // Postgres Unique Violation (e.g. Duplicate Email / Unique Index)
      case '23505': {
        statusCode = StatusCodes.CONFLICT;
        errorCode = 'DUPLICATE_RECORD';
        message = 'A record with matching unique fields already exists.';
        if (dbErr.detail) {
          details = { hint: dbErr.detail };
        }
        break;
      }

      // Postgres Foreign Key Violation
      case '23503': {
        statusCode = StatusCodes.BAD_REQUEST;
        errorCode = 'FOREIGN_KEY_CONSTRAINT_FAILED';
        message = 'Referenced relational record does not exist or has active constraints.';
        break;
      }

      // Postgres Not Null Violation
      case '23502': {
        statusCode = StatusCodes.BAD_REQUEST;
        errorCode = 'MISSING_REQUIRED_FIELD';
        message = `Required database field '${dbErr.column || 'unknown'}' cannot be null.`;
        break;
      }

      // Postgres Invalid Text Representation (e.g. Malformed UUID strings)
      case '22P02': {
        statusCode = StatusCodes.BAD_REQUEST;
        errorCode = 'INVALID_INPUT_FORMAT';
        message = 'Invalid format supplied for query database parameters (e.g., malformed UUID).';
        break;
      }

      // Postgres Database Connection / Authentication Failure
      case '28P01':
      case '57P03': {
        statusCode = StatusCodes.SERVICE_UNAVAILABLE;
        errorCode = 'DATABASE_CONNECTION_ERROR';
        message = 'Unable to establish database storage connection.';
        break;
      }

      default: {
        statusCode = StatusCodes.BAD_REQUEST;
        errorCode = `DATABASE_ERROR_${dbErr.code || 'QUERY_FAILED'}`;
        message = 'A database operation error occurred.';
        break;
      }
    }
  }

  // -------------------------------------------------------------------
  // 4. Baileys / Boom HTTP Socket Errors (WhatsApp Integration)
  // -------------------------------------------------------------------
  else if ('isBoom' in err && (err as Boom).isBoom) {
    const boomErr = err as Boom;
    const rawStatusCode = boomErr.output?.statusCode;
    statusCode = resolveHttpStatusCode(rawStatusCode, StatusCodes.INTERNAL_SERVER_ERROR);
    errorCode = `BAILEYS_SOCKET_ERROR_${statusCode}`;
    message = boomErr.message || 'WhatsApp socket connection operation failed.';
    details = boomErr.output?.payload ?? null;
  }

  // -------------------------------------------------------------------
  // 5. Express JSON Body Parsing Syntax Errors
  // -------------------------------------------------------------------
  else if ('type' in err && (err as { type: string }).type === 'entity.parse.failed') {
    statusCode = StatusCodes.BAD_REQUEST;
    errorCode = 'INVALID_JSON_PAYLOAD';
    message = 'Malformed JSON body syntax received. Please verify body formatting.';
  }

  // Log error execution internally to server logs
  logErrorDetails(err, req, errorCode, statusCode);

  // Deeply sanitize sensitive values
  const safeDetails = sanitizeSensitiveData(details);

  // Strict Security Policy: NEVER send stack traces in Production environment
  const errorEnvelopeDetails =
    env.NODE_ENV === 'development'
      ? {
          ...(safeDetails && typeof safeDetails === 'object' ? safeDetails : { info: safeDetails }),
          stack: parseStackTrace(err.stack)
        }
      : safeDetails;

  // Dispatch uniform JSON API response
  ApiResponse.error(res, message, statusCode, errorCode, errorEnvelopeDetails);
};