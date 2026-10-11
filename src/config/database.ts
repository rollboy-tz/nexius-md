// path: src/config/database.ts

import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { env } from './env.js';
import * as schema from '../db/schema.js';

const { Pool } = pg;

/**
 * Enterprise Production PostgreSQL Connection Pool Configuration.
 */
export const dbClient = new Pool({
  connectionString: env.DATABASE_URL,
  max: env.NODE_ENV === 'production' ? 20 : 10, // Maximum connections in pool
  idleTimeoutMillis: 30_000,                    // Close idle clients after 30s
  connectionTimeoutMillis: 5_000,               // Fail fast after 5s if DB is unreachable
  ssl: env.NODE_ENV === 'production' 
    ? { rejectUnauthorized: false }             // Required for cloud PostgreSQL managed services
    : false,
});

/* ============================================================================
 * POOL EVENT LISTENERS & DIAGNOSTICS
 * ========================================================================== */

dbClient.on('connect', () => {
  if (env.NODE_ENV === 'development') {
    console.log('🐘 [Database] New client connection established to PostgreSQL pool.');
  }
});

dbClient.on('error', (err: Error) => {
  console.error('💥 [Database Fatal Error]: Unexpected client error in PostgreSQL pool:', err.message);
});

/**
 * Primary Drizzle ORM Instance configured with application Database Schema.
 */
export const db = drizzle(dbClient, { 
  schema,
  logger: false //env.NODE_ENV === 'development'
});