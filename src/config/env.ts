import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  PORT: z.string().default('3000').transform((val) => parseInt(val, 10)),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  DATABASE_URL: z.string().url({ message: 'DATABASE_URL lazima iwe URL halali ya Postgres' }),
  SESSION_STORE_PATH: z.string().default('sessions'),
  API_SECRET_KEY: z.string().optional() // Kwa ajili ya kulinda API zako mbeleni
});

const _env = envSchema.safeParse(process.env);

if (!_env.success) {
  console.error('❌ Error kwenye Environment Variables:', _env.error.format());
  process.exit(1);
}

export const env = _env.data;