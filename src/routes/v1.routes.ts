import { Router } from 'express';
import sessionRoutes from './session.routes.js';

const router = Router();

/**
 * Route Module Manifest for API Version 1.
 * Aggregates all feature-specific routers under a unified '/api/v1' namespace.
 */

// 1. WhatsApp Session Management Routes
router.use('/sessions', sessionRoutes);

// 2. Direct Messaging Routes (Hapa tutaweka message.routes baadaye)
// router.use('/messages', messageRoutes);

// 3. Webhook Routes (Hapa tutaweka webhook.routes baadaye)
// router.use('/webhooks', webhookRoutes);

export default router;