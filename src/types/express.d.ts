import type { AuthSource } from '../middlewares/auth.middleware.js';
import type { AuthUser, OrgContext } from '../services/auth-session.service.js';

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
      org?: OrgContext;
      organizationId?: string;
      authSource?: AuthSource;
    }
  }
}

export {};