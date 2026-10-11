import type { NodePgQueryResultHKT } from 'drizzle-orm/node-postgres';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import type { db } from '../config/database.js';
import type * as schema from './schema.js';

/** Either the pool-backed `db` or a transaction. Lets a function join the caller's transaction. */
export type DbExecutor = PgDatabase<NodePgQueryResultHKT, typeof schema>;

/** The `tx` argument of db.transaction(...). It can open savepoints with tx.transaction(...). */
export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];