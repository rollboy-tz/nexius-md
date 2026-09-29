import type { Response } from 'express';
import { StatusCodes, type HttpStatusCode } from '../constants/status-codes.js';
import type { IApiResponse, IPaginatedApiResponse, IPaginationMeta } from '../types/api.response.js';

/**
 * Enterprise API Response Class.
 * Provides intuitive, type-safe static methods to send standardized JSON responses.
 *
 * @example
 * ```typescript
 * return ApiResponse.success(res, 'User profile fetched', user);
 * return ApiResponse.created(res, 'Session created', session);
 * ```
 */
export class ApiResponse {
  /**
   * Sends a successful HTTP response (Default Status: 200 OK).
   */
  public static success<T>(
    res: Response,
    message: string,
    data: T | null = null,
    statusCode: HttpStatusCode = StatusCodes.OK
  ): Response<IApiResponse<T>> {
    const responsePayload: IApiResponse<T> = {
      success: true,
      message,
      data,
      timestamp: new Date().toISOString()
    };

    return res.status(statusCode).json(responsePayload);
  }

  /**
   * Sends a 201 CREATED HTTP response.
   */
  public static created<T>(
    res: Response,
    message: string,
    data: T
  ): Response<IApiResponse<T>> {
    return this.success(res, message, data, StatusCodes.CREATED);
  }

  /**
   * Sends a 202 ACCEPTED HTTP response (useful for background processing/jobs).
   */
  public static accepted<T>(
    res: Response,
    message: string,
    data: T | null = null
  ): Response<IApiResponse<T>> {
    return this.success(res, message, data, StatusCodes.ACCEPTED);
  }

  /**
   * Sends a 204 NO CONTENT HTTP response.
   */
  public static noContent(res: Response): Response<void> {
    return res.status(StatusCodes.NO_CONTENT).send();
  }

  /**
   * Sends a paginated HTTP response.
   */
  public static paginated<T>(
    res: Response,
    message: string,
    data: T[],
    pagination: IPaginationMeta,
    statusCode: HttpStatusCode = StatusCodes.OK
  ): Response<IPaginatedApiResponse<T>> {
    const responsePayload: IPaginatedApiResponse<T> = {
      success: true,
      message,
      data,
      pagination,
      timestamp: new Date().toISOString()
    };

    return res.status(statusCode).json(responsePayload);
  }

  /**
   * Sends a standardized error HTTP response.
   */
  public static error(
    res: Response,
    message: string,
    statusCode: HttpStatusCode = StatusCodes.INTERNAL_SERVER_ERROR,
    errorCode: string = 'INTERNAL_SERVER_ERROR',
    details: unknown = null
  ): Response<IApiResponse<null>> {
    const responsePayload: IApiResponse<null> = {
      success: false,
      message,
      data: null,
      error: {
        code: errorCode,
        details
      },
      timestamp: new Date().toISOString()
    };

    return res.status(statusCode).json(responsePayload);
  }
}