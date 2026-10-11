// path: src/utils/sanitizer.util.ts

import createDOMPurify from 'dompurify';
import { JSDOM } from 'jsdom';

const window = new JSDOM('').window;
const DOMPurify = createDOMPurify(window);

/**
 * Enterprise Utility for sanitizing incoming payload data against XSS and Injection attacks.
 */
export class Sanitizer {
  /**
   * Sanitizes a string value by escaping HTML tags and stripping executable JavaScript.
   *
   * @param input - Raw string input from client
   * @returns Cleaned and sanitized string
   */
  public static cleanString(input: string): string {
    if (!input) return input;
    // Strip malicious XSS execution scripts
    const sanitized = DOMPurify.sanitize(input.trim(), { ALLOWED_TAGS: [] });
    return sanitized;
  }

  /**
   * Recursively sanitizes object payload properties, arrays, and nested structures.
   * Also strips dangerous operator symbols ($ and .) used in NoSQL Injections.
   *
   * @param payload - Unknown dynamic request data (body, query, params)
   * @returns Fully sanitized object payload
   */
  public static sanitizePayload<T>(payload: T): T {
    if (typeof payload === 'string') {
      return this.cleanString(payload) as unknown as T;
    }

    if (Array.isArray(payload)) {
      return payload.map((item) => this.sanitizePayload(item)) as unknown as T;
    }

    if (payload !== null && typeof payload === 'object') {
      const cleanObject: Record<string, unknown> = {};

      for (const [key, value] of Object.entries(payload)) {
        // Strip NoSQL injection operators ($where, $ne, $regex, etc.)
        const sanitizedKey = key.replace(/[\$\.]/g, '');
        cleanObject[sanitizedKey] = this.sanitizePayload(value);
      }

      return cleanObject as T;
    }

    return payload;
  }
}