// path: src/config/env.ts

import 'dotenv/config';
import { z } from 'zod';

/**
 * Environment variables validation schema for Nexius platform.
 * Ensures all required runtime environment variables exist and conform to strict types.
 */
const envSchema = z.object({
  // Server Config
  PORT: z
    .string()
    .default('3000')
    .transform((val) => parseInt(val, 10))
    .refine((port) => port > 0 && port < 65536, { message: 'PORT must be a valid network port number (1-65535)' }),

  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  // Database Connection
  DATABASE_URL: z.string().url({ message: 'DATABASE_URL must be a valid PostgreSQL connection string' }),

  // Redis Config (Session Store & Token Grace Period Cache)
  REDIS_URL: z.string().url({ message: 'REDIS_URL must be a valid Redis connection string (e.g. redis://127.0.0.1:6379)' }).default('redis://127.0.0.1:6379'),
  REDIS_PASSWORD: z.string().optional(),

  // JWT Cryptographic Secrets
  JWT_SECRET: z
    .string({ required_error: 'JWT_SECRET is required' })
    .min(32, { message: 'JWT_SECRET must be at least 32 characters long for cryptographic security' }),

  JWT_REFRESH_SECRET: z
    .string({ required_error: 'JWT_REFRESH_SECRET is required' })
    .min(32, { message: 'JWT_REFRESH_SECRET must be at least 32 characters long for cryptographic security' }),

  JWT_ACCESS_EXPIRATION: z.string().default('15m'),
  JWT_REFRESH_EXPIRATION: z.string().default('7d'),

  COOKIE_SAME_SITE: z.enum(['lax', 'none', 'strict']).default('lax'),
  COOKIE_SECURE: z.enum(['true', 'false']).default('true'),

  // Storage & Session Paths
  SESSION_STORE_PATH: z.string().default('sessions'),
  API_SECRET_KEY: z.string().optional(),

  // CORS Settings
  CORS_ORIGIN: z
    .string()
    .default('*')
    .transform((val) => val.split(',').map((origin) => origin.trim()).filter(Boolean))
    .refine(
      (origins) => origins.every((origin) => origin === '*' || z.string().url().safeParse(origin).success),
      { message: 'CORS_ORIGIN must contain valid URLs or a single "*"' }
    ),

  // SMTP Email Settings (for Email Verification & Invitations)
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z
    .string()
    .optional()
    .transform((val) => (val ? parseInt(val, 10) : 587)),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().email().optional().default('noreply@nexius.com'),

  // Application Public URLs (for Invites & Verification Links)
  APP_URL: z.string().url({ message: 'APP_URL must be a valid HTTP/HTTPS URL' }).default('http://localhost:3000'),
  FRONTEND_URL: z.string().url({ message: 'FRONTEND_URL must be a valid HTTP/HTTPS URL' }).default('http://localhost:5173'),

  // WhatsApp Multi-Device Engine Config
  WA_MAX_SESSIONS_PER_ORG: z
    .string()
    .default('5')
    .transform((val) => parseInt(val, 10)),
});

// Perform synchronous safe parse during module initialization
const _env = envSchema.safeParse(process.env);

if (!_env.success) {
  console.error('❌ Environment Variable Error:', JSON.stringify(_env.error.format(), null, 2));
  process.exit(1);
}

/**
 * Validated strongly-typed environment variables object.
 */
export const env = _env.data;

/**
 * TypeScript type inferred directly from envSchema.
 */
export type Env = z.infer<typeof envSchema>;