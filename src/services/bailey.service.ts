import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
  type ConnectionState,
  type WASocket,
  type UserFacingSocketConfig,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import P from 'pino';
import fs from 'node:fs/promises';
import path from 'node:path';

import { env } from '../config/env.js';
import { io } from '../server.js';

/* ============================================================================
 * Types
 * ========================================================================== */

export type JidType = 'USER' | 'GROUP' | 'LID' | 'NEWSLETTER' | 'BROADCAST' | 'UNKNOWN';

export interface ParsedJid {
  raw: string;
  type: JidType;
  user: string | null;
  server: string | null;
}

export interface SessionUserProfile {
  jid: string | null;
  type: JidType;
  phoneNumber: string | null;
  lid: string | null;
  name: string | null;
}

export type SessionLifecycleState =
  | 'IDLE'
  | 'CONNECTING'
  | 'AWAITING_PAIRING'
  | 'CONNECTED'
  | 'RECONNECTING'
  | 'DISCONNECTED'
  | 'LOGGED_OUT'
  | 'FAILED'
  | 'STOPPED';

export interface ConnectionRetryState {
  attempts: number;
  maxAttempts: number;
  nextDelayMs: number;
}

export interface DisconnectEvaluation {
  statusCode: number | null;
  reason: string | null;
  isLoggedOut: boolean;
  isPairingFailure: boolean;
  isPairingTransient: boolean;
  isTransient: boolean;
  shouldReconnect: boolean;
}

export interface WhatsAppConnectionOptions {
  phoneNumber?: string | null | undefined;
}

export interface PairingCodeOptions {
  phoneNumber: string;
  timeoutMs?: number;
}

interface ManagedSession {
  sessionId: string;
  sessionDir: string;
  socket: WASocket | null;
  state: SessionLifecycleState;
  generation: number;
  phoneNumber: string | null;
  stopping: boolean;
  retry: ConnectionRetryState;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  initializationPromise: Promise<void>;
  resolveInitialization: (() => void) | null;
  rejectInitialization: ((error: Error) => void) | null;
  initialized: boolean;
  pairingInProgress: boolean;
}

/* ============================================================================
 * Constants
 * ========================================================================== */

const MAX_RECONNECT_ATTEMPTS = 5;
const INITIAL_RECONNECT_DELAY_MS = 2_000;
const MAX_RECONNECT_DELAY_MS = 30_000;

const DEFAULT_PAIRING_TIMEOUT_MS = 30_000;
const PAIRING_RETRY_DELAY_MS = 750;
const PAIRING_STABILIZATION_MS = 1_500;
const INITIAL_EVENT_TIMEOUT_MS = 5_000;

const SESSION_ID_PATTERN = /^[a-zA-Z0-9_-]{1,100}$/;
const PHONE_NUMBER_PATTERN = /^\d{8,15}$/;

/* ============================================================================
 * Session stores
 * ========================================================================== */

const sessionRegistry = new Map<string, ManagedSession>();
const pendingConnections = new Map<string, Promise<WASocket>>();

/* ============================================================================
 * Logger
 * ========================================================================== */

const isDevelopment = process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'dev';

const logger = P({ level: isDevelopment ? 'info' : 'info' });

function logInfo(message: string, meta?: unknown): void {
  if (meta !== undefined) logger.info(meta, message);
  else logger.info(message);
}

function logWarn(message: string, meta?: unknown): void {
  if (meta !== undefined) logger.warn(meta, message);
  else logger.warn(message);
}

function logError(message: string, meta?: unknown): void {
  if (meta !== undefined) logger.error(meta, message);
  else logger.error(message);
}

function logDebug(message: string, meta?: unknown): void {
  if (!isDevelopment) return;
  if (meta !== undefined) logger.debug(meta, message);
  else logger.debug(message);
}

/* ============================================================================
 * Terminal logging
 * ========================================================================== */

function printSessionHeader(sessionId: string, phoneNumber: string | null): void {
  console.log('');
  console.log('╭──────────────────────────────────────────────╮');
  console.log('│ WhatsApp Session                             │');
  console.log('├──────────────────────────────────────────────┤');
  console.log(`│ Session : ${sessionId.padEnd(33)}│`);
  console.log(`│ Phone   : ${(phoneNumber ?? '-').padEnd(33)}│`);
  console.log('╰──────────────────────────────────────────────╯');
}

function terminalStatus(session: ManagedSession, status: string, detail?: string): void {
  const suffix = detail ? ` — ${detail}` : '';
  console.log(`[WA] ${session.sessionId} │ ${status}${suffix}`);
}

/* ============================================================================
 * Generic helpers
 * ========================================================================== */

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomJitter(maxMs: number): number {
  return Math.floor(Math.random() * maxMs);
}

function normalizePhoneNumber(phoneNumber: string): string {
  return phoneNumber.replace(/\D/g, '');
}

function isValidPhoneNumber(phoneNumber: string): boolean {
  return PHONE_NUMBER_PATTERN.test(phoneNumber);
}

function isValidSessionId(sessionId: string): boolean {
  return SESSION_ID_PATTERN.test(sessionId);
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;

  if (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof (error as { message?: unknown }).message === 'string'
  ) {
    return (error as { message: string }).message;
  }

  return String(error);
}

function createError(message: string): Error {
  return new Error(message);
}

/* ============================================================================
 * JID utilities
 * ========================================================================== */

export function parseJidDetails(jid: string | null | undefined): ParsedJid {
  const raw = jid?.trim() ?? '';

  if (!raw) {
    return { raw, type: 'UNKNOWN', user: null, server: null };
  }

  const [userPart, serverPart] = raw.split('@');
  const user = userPart || null;
  const server = serverPart || null;

  if (!server) {
    return { raw, type: 'UNKNOWN', user, server: null };
  }

  if (server === 'g.us') return { raw, type: 'GROUP', user, server };
  if (server === 'newsletter') return { raw, type: 'NEWSLETTER', user, server };
  if (server === 'broadcast') return { raw, type: 'BROADCAST', user, server };
  if (server === 'lid') return { raw, type: 'LID', user, server };

  if (server === 's.whatsapp.net' || server === 'c.us' || server === 'hosted') {
    return { raw, type: 'USER', user, server };
  }

  return { raw, type: 'UNKNOWN', user, server };
}

function extractSessionUserProfile(sock: WASocket, fallbackPhone?: string | null): SessionUserProfile {
  const jid = sock.user?.id ?? null;
  const parsed = parseJidDetails(jid);

  const phoneNumber =
    parsed.type === 'USER' ? parsed.user : fallbackPhone ? normalizePhoneNumber(fallbackPhone) : null;

  const lid = parsed.type === 'LID' ? parsed.user : sock.user?.lid ?? null;
  const name = sock.user?.name ?? null;

  return { jid, type: parsed.type, phoneNumber, lid, name };
}

/* ============================================================================
 * Disconnect diagnostics
 * ========================================================================== */

function extractStatusCode(error: unknown): number | null {
  if (!error) return null;

  if (error instanceof Boom) {
    return error.output.statusCode;
  }

  if (typeof error === 'object' && error !== null) {
    if ('output' in error) {
      const output = (error as { output?: { statusCode?: unknown } }).output;
      if (typeof output?.statusCode === 'number') return output.statusCode;
    }

    if ('statusCode' in error) {
      const statusCode = (error as { statusCode?: unknown }).statusCode;
      if (typeof statusCode === 'number') return statusCode;
    }
  }

  return null;
}

function getDisconnectDiagnostics(error: unknown): {
  statusCode: number | null;
  message: string;
  reason: string | null;
} {
  const statusCode = extractStatusCode(error);
  let reason: string | null = null;

  if (typeof error === 'object' && error !== null && 'data' in error) {
    const data = (error as { data?: unknown }).data;
    if (typeof data === 'string') reason = data;
  }

  return { statusCode, message: getErrorMessage(error), reason };
}

function evaluateDisconnectReason(
  lastDisconnectError: unknown,
  options: { registered: boolean },
): DisconnectEvaluation {
  const statusCode = extractStatusCode(lastDisconnectError);
  const diagnostics = getDisconnectDiagnostics(lastDisconnectError);

  const isLoggedOut = statusCode === DisconnectReason.loggedOut || (statusCode === 401 && options.registered);

  const isPairingFailure = !options.registered && statusCode === 401;

  const isPairingTransient =
    !options.registered &&
    (statusCode === 405 ||
      statusCode === 408 ||
      statusCode === 428 ||
      statusCode === 500 ||
      statusCode === 502 ||
      statusCode === 503 ||
      statusCode === 504 ||
      statusCode === 515 ||
      statusCode === null);

  const transientCodes = new Set<number>([
    DisconnectReason.connectionClosed,
    DisconnectReason.connectionLost,
    DisconnectReason.timedOut,
    DisconnectReason.restartRequired,
    408,
    428,
    500,
    502,
    503,
    504,
  ]);

  const isTransient = transientCodes.has(statusCode ?? -1) || isPairingTransient;

  const shouldReconnect = !isLoggedOut && (isTransient || isPairingFailure);

  return {
    statusCode,
    reason: diagnostics.reason,
    isLoggedOut,
    isPairingFailure,
    isPairingTransient,
    isTransient,
    shouldReconnect,
  };
}

/* ============================================================================
 * Socket.IO status events
 * ========================================================================== */

interface SessionStatusPayload {
  state: SessionLifecycleState;
  statusCode?: number | null;
  reason?: string | null;
  message?: string;
  phoneNumber?: string | null;
  pairingCode?: string | null;
  profile?: SessionUserProfile | null;
  retry?: ConnectionRetryState | null;
}

function emitSessionStatus(sessionId: string, payload: SessionStatusPayload): void {
  io.to(sessionId).emit('session_status', {
    sessionId,
    ...payload,
    timestamp: new Date().toISOString(),
  });
}

/* ============================================================================
 * Retry helpers
 * ========================================================================== */

function calculateReconnectDelay(attempt: number): number {
  const exponentialDelay = Math.min(INITIAL_RECONNECT_DELAY_MS * 2 ** Math.max(attempt - 1, 0), MAX_RECONNECT_DELAY_MS);
  return exponentialDelay + randomJitter(500);
}

function resetRetryState(session: ManagedSession): void {
  session.retry = { attempts: 0, maxAttempts: MAX_RECONNECT_ATTEMPTS, nextDelayMs: 0 };
}

function clearReconnectTimer(session: ManagedSession): void {
  if (!session.reconnectTimer) return;
  clearTimeout(session.reconnectTimer);
  session.reconnectTimer = null;
}

function safelyDestroySocket(sock: WASocket | null): void {
  if (!sock) return;

  try {
    sock.ev.removeAllListeners('connection.update');
    sock.ev.removeAllListeners('creds.update');

    sock.ws?.close();
    sock.end(undefined);
  } catch (error) {
    logDebug('Socket cleanup error ignored.', { error: getErrorMessage(error) });
  }
}

/* ============================================================================
 * Initialization gate
 * ========================================================================== */

function createInitializationGate(session: ManagedSession): void {
  session.initialized = false;

  session.initializationPromise = new Promise<void>((resolve, reject) => {
    session.resolveInitialization = resolve;
    session.rejectInitialization = reject;
  });
}

function resolveInitializationGate(session: ManagedSession): void {
  if (session.initialized) return;

  session.initialized = true;
  session.resolveInitialization?.();

  session.resolveInitialization = null;
  session.rejectInitialization = null;
}

function rejectInitializationGate(session: ManagedSession, error: Error): void {
  if (session.initialized) return;

  session.rejectInitialization?.(error);

  session.resolveInitialization = null;
  session.rejectInitialization = null;
}

async function waitForPairingInitialization(session: ManagedSession, timeoutMs: number): Promise<void> {
  if (!session.initialized) {
    let timeout: ReturnType<typeof setTimeout> | null = null;

    try {
      await Promise.race([
        session.initializationPromise,
        new Promise<void>((_, reject) => {
          timeout = setTimeout(() => {
            reject(createError('Timed out waiting for WhatsApp socket initialization.'));
          }, Math.min(timeoutMs, INITIAL_EVENT_TIMEOUT_MS));
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  await sleep(PAIRING_STABILIZATION_MS);
}

/* ============================================================================
 * Session directory management
 * ========================================================================== */

function getSessionDirectory(sessionId: string): string {
  return path.join(env.SESSION_STORE_PATH, sessionId);
}

async function removeSessionDirectory(sessionDir: string): Promise<void> {
  try {
    await fs.rm(sessionDir, { recursive: true, force: true });
  } catch (error) {
    logWarn('Failed to remove WhatsApp session directory.', { sessionDir, error: getErrorMessage(error) });
  }
}

/* ============================================================================
 * Socket factory
 * ========================================================================== */

async function createSocket(session: ManagedSession): Promise<WASocket> {
  const generation = session.generation;

  const { state, saveCreds } = await useMultiFileAuthState(session.sessionDir);
  const { version } = await fetchLatestBaileysVersion();

  const config: UserFacingSocketConfig = {
    version,
    auth: state,
    printQRInTerminal: false,
    logger: P({ level: 'silent' }),
  };

  const sock = makeWASocket(config);

  const previousSocket = session.socket;
  session.socket = sock;

  if (previousSocket && previousSocket !== sock) {
    safelyDestroySocket(previousSocket);
  }

  sock.ev.on('creds.update', async () => {
    try {
      await saveCreds();
    } catch (error) {
      logError(`Failed to save credentials for ${session.sessionId}.`, { error: getErrorMessage(error) });
    }
  });

  sock.ev.on('connection.update', async (update) => {
    try {
      await handleConnectionUpdate(session, sock, generation, update);
    } catch (error) {
      logError(`Unhandled connection.update error for ${session.sessionId}.`, { error: getErrorMessage(error) });
    }
  });

  terminalStatus(session, 'SOCKET_CREATED');

  return sock;
}

/* ============================================================================
 * Connection update handler
 * ========================================================================== */

async function handleConnectionUpdate(
  session: ManagedSession,
  sock: WASocket,
  generation: number,
  update: Partial<ConnectionState>,
): Promise<void> {
  if (session.generation !== generation || session.socket !== sock) {
    logDebug(`Ignoring obsolete socket event for ${session.sessionId}.`);
    safelyDestroySocket(sock);
    return;
  }

  resolveInitializationGate(session);

  const { connection, lastDisconnect } = update;

  /* -------------------------------------------------------------- CONNECTING */

  if (connection === 'connecting') {
    session.state = 'CONNECTING';

    terminalStatus(session, 'CONNECTING');

    emitSessionStatus(session.sessionId, {
      state: 'CONNECTING',
      phoneNumber: session.phoneNumber,
    });

    return;
  }

  /* -------------------------------------------------------------------- OPEN */

  if (connection === 'open') {
    const profile = extractSessionUserProfile(sock, session.phoneNumber);

    session.state = 'CONNECTED';
    session.stopping = false;
    session.phoneNumber = profile.phoneNumber ?? session.phoneNumber;

    resetRetryState(session);
    clearReconnectTimer(session);

    terminalStatus(session, 'CONNECTED', profile.phoneNumber ?? profile.jid ?? 'WhatsApp session is online');

    emitSessionStatus(session.sessionId, {
      state: 'CONNECTED',
      phoneNumber: session.phoneNumber,
      profile,
    });

    return;
  }

  /* ------------------------------------------------------------------- CLOSE */

  if (connection !== 'close') return;

  const diagnostics = getDisconnectDiagnostics(lastDisconnect?.error);
  const evaluation = evaluateDisconnectReason(lastDisconnect?.error, {
    registered: sock.authState.creds.registered,
  });

  const statusText = evaluation.statusCode !== null ? `HTTP ${evaluation.statusCode}` : 'unknown reason';

  terminalStatus(session, 'SOCKET_CLOSED', statusText);

  logDebug(`WhatsApp socket closed for ${session.sessionId}.`, {
    statusCode: evaluation.statusCode,
    reason: evaluation.reason,
    message: diagnostics.message,
    registered: sock.authState.creds.registered,
    pairingInProgress: session.pairingInProgress,
  });

  rejectInitializationGate(
    session,
    createError(
      evaluation.statusCode
        ? `WhatsApp socket closed with status ${evaluation.statusCode}.`
        : 'WhatsApp socket closed before initialization completed.',
    ),
  );

  if (session.stopping) return;

  /* -------------------------------------------------------------- LOGGED OUT */

  if (evaluation.isLoggedOut) {
    session.state = 'LOGGED_OUT';
    session.stopping = true;

    clearReconnectTimer(session);

    if (session.socket === sock) session.socket = null;

    emitSessionStatus(session.sessionId, {
      state: 'LOGGED_OUT',
      statusCode: evaluation.statusCode,
      reason: evaluation.reason,
      message: 'WhatsApp session has been logged out.',
    });

    terminalStatus(session, 'LOGGED_OUT', 'Authentication was revoked');

    sessionRegistry.delete(session.sessionId);

    await sleep(300);
    await removeSessionDirectory(session.sessionDir);

    return;
  }

  /*
   * Pairing recovery is owned by requestPairingCodeSafely().
   *
   * Do NOT schedule another reconnect here while pairing is active.
   * Otherwise the pairing loop and reconnect scheduler can create two
   * sockets at the same time.
   */
  if (session.pairingInProgress && !sock.authState.creds.registered) {
    if (session.socket === sock) session.socket = null;

    session.state = 'RECONNECTING';

    terminalStatus(session, 'PAIRING_RECOVERY', `Baileys closed (${statusText}); retrying internally`);

    return;
  }

  /* ---------------------------------------------------------- TRANSIENT DISC. */

  if (evaluation.shouldReconnect) {
    if (session.socket === sock) session.socket = null;

    safelyDestroySocket(sock);

    session.state = 'DISCONNECTED';

    emitSessionStatus(session.sessionId, {
      state: 'DISCONNECTED',
      statusCode: evaluation.statusCode,
      reason: evaluation.reason,
      message: 'WhatsApp connection interrupted. Reconnecting internally.',
    });

    scheduleReconnect(session);
    return;
  }

  /* --------------------------------------------------------- NON-RECOVERABLE */

  if (session.socket === sock) session.socket = null;

  safelyDestroySocket(sock);

  session.state = 'FAILED';

  emitSessionStatus(session.sessionId, {
    state: 'FAILED',
    statusCode: evaluation.statusCode,
    reason: evaluation.reason,
    message: 'WhatsApp connection stopped because the disconnect reason was not recoverable.',
  });

  terminalStatus(session, 'FAILED', `Non-recoverable disconnect (${statusText})`);
}

/* ============================================================================
 * Reconnect scheduler
 * ========================================================================== */

function scheduleReconnect(session: ManagedSession): void {
  if (session.stopping || session.pairingInProgress || session.reconnectTimer) {
    return;
  }

  if (session.retry.attempts >= session.retry.maxAttempts) {
    session.state = 'FAILED';

    emitSessionStatus(session.sessionId, {
      state: 'FAILED',
      message: 'WhatsApp connection failed after maximum reconnect attempts.',
      retry: session.retry,
    });

    terminalStatus(session, 'FAILED', 'Maximum reconnect attempts reached');

    return;
  }

  session.retry.attempts += 1;

  const delay = calculateReconnectDelay(session.retry.attempts);
  session.retry.nextDelayMs = delay;
  session.state = 'RECONNECTING';

  emitSessionStatus(session.sessionId, { state: 'RECONNECTING', retry: session.retry });

  terminalStatus(
    session,
    'RECONNECTING',
    `attempt ${session.retry.attempts}/${session.retry.maxAttempts}, waiting ${delay}ms`,
  );

  session.reconnectTimer = setTimeout(() => {
    session.reconnectTimer = null;

    if (session.stopping || session.pairingInProgress) return;

    void establishConnection(session.sessionId, { phoneNumber: session.phoneNumber }).catch((error) => {
      logError(`Internal reconnect failed for ${session.sessionId}.`, { error: getErrorMessage(error) });

      if (!session.stopping && !session.pairingInProgress) {
        scheduleReconnect(session);
      }
    });
  }, delay);
}

/* ============================================================================
 * Pairing code recovery
 * ========================================================================== */

function isRetryablePairingError(error: unknown): boolean {
  const statusCode = extractStatusCode(error);

  if (
    statusCode === 401 ||
    statusCode === 405 ||
    statusCode === 408 ||
    statusCode === 428 ||
    statusCode === 500 ||
    statusCode === 502 ||
    statusCode === 503 ||
    statusCode === 504 ||
    statusCode === 515 ||
    statusCode === null
  ) {
    const message = getErrorMessage(error).toLowerCase();

    return (
      statusCode !== null ||
      message.includes('connection closed') ||
      message.includes('connection lost') ||
      message.includes('timed out') ||
      message.includes('socket')
    );
  }

  return false;
}

async function createReplacementSocket(session: ManagedSession): Promise<WASocket> {
  clearReconnectTimer(session);

  const oldSocket = session.socket;
  session.socket = null;

  if (oldSocket) safelyDestroySocket(oldSocket);

  session.generation += 1;
  createInitializationGate(session);

  session.state = 'CONNECTING';

  return createSocket(session);
}

async function requestPairingCodeOnCurrentSocket(
  session: ManagedSession,
  phoneNumber: string,
  timeoutMs: number,
): Promise<string> {
  const sock = session.socket;

  if (!sock) {
    throw createError('WhatsApp socket is not available.');
  }

  if (sock.authState.creds.registered) {
    throw createError('This WhatsApp session is already registered.');
  }

  await waitForPairingInitialization(session, timeoutMs);

  if (session.socket !== sock || session.stopping) {
    throw createError('WhatsApp pairing socket was replaced or stopped.');
  }

  if (sock.authState.creds.registered) {
    throw createError('WhatsApp session became registered before pairing code request.');
  }

  terminalStatus(session, 'READY', 'requesting pairing code');

  const pairingCode = await sock.requestPairingCode(phoneNumber);

  if (!pairingCode) {
    throw createError('WhatsApp returned an empty pairing code.');
  }

  return pairingCode;
}

function formatPairingCode(pairingCode: string): string {
  const normalized = pairingCode.replace(/\s+/g, '');
  return normalized.match(/.{1,4}/g)?.join('-') ?? normalized;
}

/**
 * Requests a pairing code and owns all transient Baileys recovery internally.
 *
 * SessionManager receives only the final result. Temporary 428/405/etc.
 * errors never escape to SessionManager while this operation is retrying.
 */
export async function requestPairingCodeSafely(sessionId: string, options: PairingCodeOptions): Promise<string> {
  if (!isValidSessionId(sessionId)) {
    throw createError('Invalid WhatsApp session ID.');
  }

  const phoneNumber = normalizePhoneNumber(options.phoneNumber);

  if (!isValidPhoneNumber(phoneNumber)) {
    throw createError('Invalid phone number. Use international format without + or spaces.');
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_PAIRING_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;

  const session = sessionRegistry.get(sessionId);

  if (!session) {
    throw createError(`WhatsApp session ${sessionId} is not active.`);
  }

  if (session.stopping) {
    throw createError(`WhatsApp session ${sessionId} is stopping.`);
  }

  session.phoneNumber = phoneNumber;
  session.pairingInProgress = true;
  session.state = 'AWAITING_PAIRING';

  printSessionHeader(sessionId, phoneNumber);

  emitSessionStatus(sessionId, {
    state: 'AWAITING_PAIRING',
    phoneNumber,
    message: 'Pairing code request is being prepared.',
  });

  try {
    while (Date.now() < deadline) {
      if (session.stopping) {
        throw createError(`WhatsApp session ${sessionId} is stopping.`);
      }

      let sock = session.socket;

      if (!sock) {
        // Kama /start (establishConnection) bado iko njiani kuunda socket
        // yake, tumia MATOKEO YAKE badala ya kuunda socket ya pili
        // inayogombania auth directory moja. Bila hili, /pair ikifika
        // haraka sana baada ya /start, tunapata race condition ile ile
        // tuliyoirekebisha kwenye establishConnection — lakini kupitia
        // njia hii tofauti ambayo haitumii pendingConnections.
        const inFlight = pendingConnections.get(session.sessionId);

        if (inFlight) {
          terminalStatus(session, 'WAITING', 'joining in-flight connection attempt from /start');

          try {
            sock = await inFlight;
          } catch {
            sock = null;
          }
        }

        if (!sock) {
          terminalStatus(session, 'RECOVERING', 'creating WhatsApp socket');
          sock = await createReplacementSocket(session);
        }
      }

      if (sock.authState.creds.registered) {
        throw createError('This WhatsApp session is already registered.');
      }

      try {
        const pairingCode = await requestPairingCodeOnCurrentSocket(
          session,
          phoneNumber,
          Math.max(1_000, deadline - Date.now()),
        );

        const formattedCode = formatPairingCode(pairingCode);

        session.state = 'AWAITING_PAIRING';

        terminalStatus(session, 'PAIRING_CODE', formattedCode);

        emitSessionStatus(sessionId, {
          state: 'AWAITING_PAIRING',
          phoneNumber,
          pairingCode: formattedCode,
          message: 'Pairing code generated successfully.',
        });

        return formattedCode;
      } catch (error) {
        const diagnostics = getDisconnectDiagnostics(error);
        const retryable = isRetryablePairingError(error);

        if (!retryable) {
          throw error;
        }

        const remaining = deadline - Date.now();

        if (remaining <= 0) break;

        terminalStatus(
          session,
          'PAIRING_RETRY',
          diagnostics.statusCode !== null ? `Baileys ${diagnostics.statusCode}` : diagnostics.message,
        );

        if (session.socket === sock) session.socket = null;

        safelyDestroySocket(sock);

        if (Date.now() >= deadline) break;

        await sleep(Math.min(PAIRING_RETRY_DELAY_MS, Math.max(0, deadline - Date.now())));

        if (Date.now() >= deadline) break;

        session.generation += 1;
        createInitializationGate(session);

        terminalStatus(session, 'RECONNECTING', 'pairing recovery is internal');

        await createSocket(session);
      }
    }

    session.state = 'FAILED';

    terminalStatus(session, 'FAILED', 'pairing timeout reached');

    emitSessionStatus(sessionId, {
      state: 'FAILED',
      phoneNumber,
      message: 'Unable to obtain a WhatsApp pairing code within the configured timeout.',
    });

    throw createError('Unable to obtain a WhatsApp pairing code within the configured timeout.');
  } finally {
    session.pairingInProgress = false;
  }
}

/* ============================================================================
 * Public connection API
 * ========================================================================== */

export async function establishConnection(sessionId: string, options: WhatsAppConnectionOptions = {}): Promise<WASocket> {
  if (!isValidSessionId(sessionId)) {
    throw createError('Invalid WhatsApp session ID.');
  }

  const normalizedPhone = options.phoneNumber ? normalizePhoneNumber(options.phoneNumber) : null;

  if (normalizedPhone && !isValidPhoneNumber(normalizedPhone)) {
    throw createError('Invalid phone number.');
  }

  const existingPending = pendingConnections.get(sessionId);

  if (existingPending) {
    return existingPending;
  }

  let session = sessionRegistry.get(sessionId);

  if (!session) {
    session = {
      sessionId,
      sessionDir: getSessionDirectory(sessionId),
      socket: null,
      state: 'IDLE',
      generation: 0,
      phoneNumber: normalizedPhone,
      stopping: false,
      retry: { attempts: 0, maxAttempts: MAX_RECONNECT_ATTEMPTS, nextDelayMs: 0 },
      reconnectTimer: null,
      initializationPromise: Promise.resolve(),
      resolveInitialization: null,
      rejectInitialization: null,
      initialized: false,
      pairingInProgress: false,
    };

    sessionRegistry.set(sessionId, session);
  } else if (normalizedPhone) {
    session.phoneNumber = normalizedPhone;
  }

  session.stopping = false;
  session.generation += 1;

  clearReconnectTimer(session);
  createInitializationGate(session);

  terminalStatus(session, 'CONNECTING', 'creating socket');

  const connectionPromise = (async () => {
    try {
      return await createSocket(session!);
    } finally {
      pendingConnections.delete(sessionId);
    }
  })();

  pendingConnections.set(sessionId, connectionPromise);

  return connectionPromise;
}

export async function stopConnection(sessionId: string): Promise<void> {
  const session = sessionRegistry.get(sessionId);

  if (!session) return;

  session.stopping = true;
  session.pairingInProgress = false;

  clearReconnectTimer(session);

  const socketToDestroy = session.socket;
  session.socket = null;

  safelyDestroySocket(socketToDestroy);

  session.state = 'STOPPED';

  sessionRegistry.delete(sessionId);

  emitSessionStatus(sessionId, {
    state: 'STOPPED',
    message: 'WhatsApp session connection was stopped manually.',
  });

  terminalStatus(session, 'STOPPED', 'manual stop');
}

/* ============================================================================
 * Accessors
 * ========================================================================== */

export function getSession(sessionId: string): ManagedSession | null {
  return sessionRegistry.get(sessionId) ?? null;
}

export function getSessionState(sessionId: string): SessionLifecycleState | null {
  return sessionRegistry.get(sessionId)?.state ?? null;
}

export function getSessionProfile(sessionId: string): SessionUserProfile | null {
  const session = sessionRegistry.get(sessionId);

  if (!session?.socket) return null;

  return extractSessionUserProfile(session.socket, session.phoneNumber);
}

export function getActiveSessionIds(): string[] {
  return [...sessionRegistry.keys()];
}

/* ============================================================================
 * Shutdown
 * ========================================================================== */

export async function shutdownAllConnections(): Promise<void> {
  const sessionIds = [...sessionRegistry.keys()];

  await Promise.allSettled(sessionIds.map((sessionId) => stopConnection(sessionId)));

  pendingConnections.clear();
}