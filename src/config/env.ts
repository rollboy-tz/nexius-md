import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  PORT: z.string().default('3000').transform((val) => parseInt(val, 10)),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  DATABASE_URL: z.string().url({ message: 'DATABASE_URL must be a valid PostgreSQL connection string' }),
  SESSION_STORE_PATH: z.string().default('sessions'),
  API_SECRET_KEY: z.string().optional(),
  CORS_ORIGIN: z.string().default('*').transform((val) =>val.split(',').map((origin) => origin.trim()).filter(Boolean))
    .refine((origins) =>
        origins.every((origin) => origin === '*' || z.string().url().safeParse(origin).success),
      { message: 'CORS_ORIGIN must contain valid URLs or a single "*"' }),
});

const _env = envSchema.safeParse(process.env);

if (!_env.success) {
  console.error('❌ Environment Variable Error:', _env.error.format());
  process.exit(1);
}

export const env = _env.data;