interface PgErrorLike {
  code?: string;
  constraint?: string;
  cause?: unknown;
}

/** Drizzle (recent versions) wraps the driver error in `cause`; older ones throw it directly. */
function unwrapPgError(error: unknown): PgErrorLike | null {
  let current: unknown = error;

  for (let depth = 0; depth < 3 && current && typeof current === 'object'; depth += 1) {
    if ('code' in current) return current as PgErrorLike;
    current = (current as { cause?: unknown }).cause;
  }

  return null;
}

/** True for Postgres 23505. Pass a constraint/index name to match one specific rule. */
export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  const pgError = unwrapPgError(error);
  if (!pgError || pgError.code !== '23505') return false;
  return constraint ? pgError.constraint === constraint : true;
}