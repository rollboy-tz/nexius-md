import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { env } from './env.js';

const connectionString = env.DATABASE_URL;

if (!connectionString) {
  throw new Error('❌ [ENV Error]: DATABASE_URL is missing in environment variables.');
}

// Enterprise Connection Pooling
const pool = new pg.Pool({
  connectionString,
  max: 20, // Max clients in pool
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

const adapter = new PrismaPg(pool);

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    adapter,
    log:
      process.env.NODE_ENV === 'development'
        ? ['query', 'error', 'warn']
        : ['error'],
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = db;
}

export async function connectDB(): Promise<void> {
  try {
    await db.$connect();
    console.log('🐘 [Database]: PostgreSQL connected successfully via Prisma 7 Adapter!');
  } catch (error) {
    console.error('❌ [Database]: Connection Error:', error);
    process.exit(1);
  }
}

// Graceful Shutdown Handler for Production (Render / Docker)
const handleShutdown = async () => {
  console.log('⏳ [Database]: Closing database connections...');
  await db.$disconnect();
  await pool.end();
  console.log('🛑 [Database]: Connections closed successfully.');
  process.exit(0);
};

process.on('SIGINT', handleShutdown);
process.on('SIGTERM', handleShutdown);