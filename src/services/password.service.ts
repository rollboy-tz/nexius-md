import argon2 from 'argon2';
import bcrypt from 'bcryptjs';
import { ApiError } from '../utils/api.error.js';
import { randomToken } from '../utils/crypto.util.js';

const OPTIONS = { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

let dummyHash: Promise<string> | null = null;
const getDummyHash = (): Promise<string> => (dummyHash ??= argon2.hash(randomToken(16), OPTIONS));

export function validatePasswordPolicy(password: string, email?: string): void {
  if (typeof password !== 'string' || password.length < 10 || password.length > 128) {
    throw ApiError.badRequest('Password must be between 10 and 128 characters.', 'WEAK_PASSWORD');
  }
  if (email && password.toLowerCase() === email.toLowerCase()) {
    throw ApiError.badRequest('Password must not be your email address.', 'WEAK_PASSWORD');
  }
}

export class PasswordService {
  public static hash(password: string): Promise<string> {
    return argon2.hash(password, OPTIONS);
  }

  /** With no stored hash it still does the work of a real comparison, so timing reveals nothing. */
  public static async verify(
    storedHash: string | null | undefined,
    password: string,
  ): Promise<{ valid: boolean; needsRehash: boolean }> {
    if (!storedHash) {
      await argon2.verify(await getDummyHash(), password).catch(() => false);
      return { valid: false, needsRehash: false };
    }

    if (storedHash.startsWith('$2')) {
      const valid = await bcrypt.compare(password, storedHash);
      return { valid, needsRehash: valid };
    }

    try {
      const valid = await argon2.verify(storedHash, password);
      return { valid, needsRehash: valid && argon2.needsRehash(storedHash, OPTIONS) };
    } catch {
      return { valid: false, needsRehash: false };
    }
  }
}