import crypto from 'node:crypto';

export const sha256Hex = (value: string): string => crypto.createHash('sha256').update(value).digest('hex');

/** URL-safe random string. 32 bytes = 256 bits of entropy. */
export const randomToken = (bytes = 32): string => crypto.randomBytes(bytes).toString('base64url');

/** Constant-time string comparison that never throws on different lengths. */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

/** Derives an independent 256-bit key from a master secret, so one secret is never reused for two purposes. */
export function deriveKey(secret: string, info: string): Buffer {
  return Buffer.from(crypto.hkdfSync('sha256', secret, 'nexius-kdf-salt-v1', info, 32));
}

/** AES-256-GCM. Output: iv.tag.ciphertext (base64url). */
export function encryptJson(value: unknown, key: Buffer): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), ciphertext].map((part) => part.toString('base64url')).join('.');
}

/** Returns null for anything that is not a valid, untampered payload. */
export function decryptJson<T>(payload: string, key: Buffer): T | null {
  try {
    const [iv, tag, data] = payload.split('.').map((part) => Buffer.from(part, 'base64url'));
    if (!iv || !tag || !data) return null;

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);

    return JSON.parse(Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')) as T;
  } catch {
    return null;
  }
}