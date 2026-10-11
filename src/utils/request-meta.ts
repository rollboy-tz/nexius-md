import type { Request } from 'express';
import type { RequestMeta } from '../services/audit.service.js';

/** Who and from where, for the audit log. Set `trust proxy` in app.ts so `req.ip` is the real client. */
export const metaOf = (req: Request): RequestMeta => ({
  ipAddress: req.ip,
  userAgent: req.get('user-agent'),
  requestId: req.get('x-request-id'),
});