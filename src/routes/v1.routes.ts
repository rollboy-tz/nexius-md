import { Router } from 'express';
import authRoutes from './auth.routes.js';
import organizationRoutes, { invitationRoutes } from './organization.routes.js';

const router = Router();

router.use('/auth', authRoutes);
router.use('/organizations', organizationRoutes);
router.use('/invitations',   invitationRoutes);

export default router;