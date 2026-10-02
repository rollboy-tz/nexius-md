import type { Server as SocketIOServer } from 'socket.io';

/* ============================================================================
 * Types
 * ========================================================================== */

export type SessionLogLevel = 'info' | 'warn' | 'error' | 'debug' | 'status' | 'terminal';

export interface SessionLogEntry {
  /** Monotonic per-session counter. The frontend uses it to order and de-duplicate. */
  seq: number;
  sessionId: string;
  level: SessionLogLevel;
  message: string;
  meta?: unknown;
  timestamp: string;
}

/** Structural match for Baileys' ILogger so we do not depend on its internal types. */
export interface BaileysLoggerLike {
  level: string;
  child(bindings: Record<string, unknown>): BaileysLoggerLike;
  trace(obj: unknown, msg?: string): void;
  debug(obj: unknown, msg?: string): void;
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

/* ============================================================================
 * Constants & state
 * ========================================================================== */

const LOG_BUFFER_LIMIT = 500;
const MAX_MESSAGE_LENGTH = 4_000;
const MAX_STRING_LENGTH = 2_000;
const MAX_DEPTH = 4;
const MAX_KEYS = 40;

/** Keys whose values must never leave the server, whatever the log level. */
const REDACTED_KEY = /(authorization|token|password|secret|cookie|creds|private|noise|signed|api[-_]?key)/i;

let ioRef: SocketIOServer | null = null;

const buffers = new Map<string, SessionLogEntry[]>();
const counters = new Map<string, number>();

/** Called once from server.ts, right after the Socket.IO server is created. */
export function bindLogSocketServer(server: SocketIOServer): void {
  ioRef = server;
}

/* ============================================================================
 * Sanitising (safe JSON, redaction, size limits)
 * ========================================================================== */

function sanitize(value: unknown, depth = 0, seen: WeakSet<object> = new WeakSet()): unknown {
  if (value === null || value === undefined) return value;

  switch (typeof value) {
    case 'string':
      return value.length > MAX_STRING_LENGTH
        ? `${value.slice(0, MAX_STRING_LENGTH)}… (+${value.length - MAX_STRING_LENGTH} chars)`
        : value;
    case 'number':
    case 'boolean':
      return value;
    case 'bigint':
      return value.toString();
    case 'function':
    case 'symbol':
      return `[${typeof value}]`;
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack?.split('\n').slice(0, 6).join('\n'),
    };
  }

  if (value instanceof Uint8Array) return `[binary ${value.length} bytes]`;

  const obj = value as object;
  if (seen.has(obj)) return '[circular]';
  if (depth >= MAX_DEPTH) return '[max depth]';
  seen.add(obj);

  if (Array.isArray(obj)) {
    return obj.slice(0, MAX_KEYS).map((item) => sanitize(item, depth + 1, seen));
  }

  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(obj).slice(0, MAX_KEYS)) {
    out[key] = REDACTED_KEY.test(key) ? '[redacted]' : sanitize(val, depth + 1, seen);
  }
  return out;
}

/* ============================================================================
 * Public API
 * ========================================================================== */

export function emitSessionLog(
  sessionId: string,
  level: SessionLogLevel,
  message: string,
  meta?: unknown,
): void {
  try {
    const seq = (counters.get(sessionId) ?? 0) + 1;
    counters.set(sessionId, seq);

    const entry: SessionLogEntry = {
      seq,
      sessionId,
      level,
      message: message.length > MAX_MESSAGE_LENGTH ? `${message.slice(0, MAX_MESSAGE_LENGTH)}…` : message,
      ...(meta !== undefined ? { meta: sanitize(meta) } : {}),
      timestamp: new Date().toISOString(),
    };

    // Ring buffer: late viewers (or reconnecting ones) receive this as a backlog.
    const buffer = buffers.get(sessionId) ?? [];
    buffer.push(entry);
    if (buffer.length > LOG_BUFFER_LIMIT) buffer.splice(0, buffer.length - LOG_BUFFER_LIMIT);
    buffers.set(sessionId, buffer);

    ioRef?.to(sessionId).emit('session_log', entry);
  } catch {
    // Log streaming must never break connection logic.
  }
}

export function getSessionLogs(sessionId: string): SessionLogEntry[] {
  return buffers.get(sessionId) ?? [];
}

/**
 * Drops the in-memory buffer.
 *
 * `notify` is false by default on purpose: the automatic clean-up after a session
 * ends must NOT wipe the screen of someone still reading the final lines.
 * Only an explicit "Clear" from a viewer passes `notify: true`.
 */
export function clearSessionLogs(sessionId: string, options: { notify?: boolean } = {}): void {
  buffers.delete(sessionId);

  if (options.notify) {
    ioRef?.to(sessionId).emit('session_logs_cleared', {
      sessionId,
      timestamp: new Date().toISOString(),
    });
  }
}

/* ============================================================================
 * Baileys logger bridge
 *
 * Baileys' own logger was `silent`, so everything it knew (retries, stream
 * errors, key-sync problems) never reached the screen. This bridge forwards
 * it into the same session stream.
 * ========================================================================== */

type BridgeLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'silent';
const LEVEL_ORDER: BridgeLevel[] = ['trace', 'debug', 'info', 'warn', 'error', 'silent'];

export function createBaileysLogger(sessionId: string, level: BridgeLevel = 'warn'): BaileysLoggerLike {
  const threshold = LEVEL_ORDER.indexOf(level);

  const make = (bindings: Record<string, unknown>): BaileysLoggerLike => {
    const forward =
      (lvl: Exclude<BridgeLevel, 'silent'>) =>
      (obj: unknown, msg?: string): void => {
        if (LEVEL_ORDER.indexOf(lvl) < threshold) return;

        const isText = typeof obj === 'string';
        const message = `[baileys] ${isText ? obj : (msg ?? 'event')}`;
        const meta = isText ? undefined : { ...bindings, ...(typeof obj === 'object' && obj !== null ? obj : { value: obj }) };

        emitSessionLog(sessionId, lvl === 'trace' ? 'debug' : lvl, message, meta ?? (Object.keys(bindings).length ? bindings : undefined));
      };

    return {
      level,
      child: (extra) => make({ ...bindings, ...extra }),
      trace: forward('trace'),
      debug: forward('debug'),
      info: forward('info'),
      warn: forward('warn'),
      error: forward('error'),
    };
  };

  return make({});
}