import type { HttpStatusCode } from '../constants/status-codes.js';

/**
 * Standard API Response Envelope Structure.
 *
 * @template T - Type of payload data returned in successful operations
 */
export interface IApiResponse<T = unknown> {
  /** Indicates operation outcome */
  success: boolean;

  /** Human-readable operational message describing the outcome */
  message: string;

  /** Primary payload data (populated on success, null or undefined on error) */
  data?: T | null;

  /** Error details object (populated only on failures) */
  error?: {
    /** Application/Domain-specific error code */
    code: string;
    /** Granular error details or validation issue breakdown */
    details?: unknown;
  } | null;

  /** ISO 8601 Timestamp of response dispatch */
  timestamp: string;
}

/**
 * Standardized Pagination Metadata Structure.
 */
export interface IPaginationMeta {
  page: number;
  limit: number;
  totalItems: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPrevPage: boolean;
}

/**
 * Paginated API Response Envelope Structure.
 */
export interface IPaginatedApiResponse<T = unknown> extends IApiResponse<T[]> {
  pagination: IPaginationMeta;
}