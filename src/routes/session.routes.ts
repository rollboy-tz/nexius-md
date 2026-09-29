import { Router } from 'express';
import { sessionController } from '../controllers/session.controller.js';
import { validateRequest } from '../middlewares/validate-request.middleware.js';
import { sessionSchema } from '../schemas/session.schema.js';

/**
 * Express Router managing WhatsApp Session lifecycle endpoints,
 * pairing authentication, status monitoring, and message dispatching.
 */
const router = Router();

/**
 * @route   POST /api/v1/sessions/start
 * @desc    Begin establishing a WhatsApp socket for a session. Returns
 *          immediately (202) without waiting for the socket to connect —
 *          call this first, then either GET /:sessionId/status or listen
 *          for the 'session_status' Socket.IO event, then call /pair once
 *          ready (or just call /pair directly; it will wait for /start's
 *          in-flight connection instead of racing it).
 * @access  Protected / Internal API
 */
router.post(
  '/start',
  validateRequest(sessionSchema.startSession),
  sessionController.startSession
);

/**
 * @route   POST /api/v1/sessions/pair
 * @desc    Request a WhatsApp Pairing Code for authenticating a new or existing session.
 *          Blocks up to the service's internal deadline (~30s) while it
 *          retries transient WhatsApp errors — call /start first if you
 *          want the socket creation cost paid outside of this request.
 * @access  Protected / Internal API
 */
router.post(
  '/pair',
  validateRequest(sessionSchema.requestPairing),
  sessionController.requestPairing
);

/**
 * @route   GET /api/v1/sessions/:sessionId/status
 * @desc    Get runtime state and database connection status of a specific session
 * @access  Protected / Internal API
 */
router.get(
  '/:sessionId/status',
  validateRequest(sessionSchema.sessionParam),
  sessionController.getStatus
);

/**
 * @route   GET /api/v1/sessions
 * @desc    Fetch all registered database sessions alongside active memory pool count
 * @access  Protected / Internal API
 */
router.get(
  '/',
  sessionController.listSessions
);

/**
 * @route   POST /api/v1/sessions/send-message
 * @desc    Dispatch a text message through an active authenticated session
 * @access  Protected / Internal API
 */
router.post(
  '/send-message',
  validateRequest(sessionSchema.sendMessage),
  sessionController.sendMessage
);

/**
 * @route   DELETE /api/v1/sessions/:sessionId
 * @desc    Safely disconnect socket, purge from memory, and update database status
 * @access  Protected / Internal API
 */
router.delete(
  '/:sessionId',
  validateRequest(sessionSchema.sessionParam),
  sessionController.deleteSession
);

export default router;