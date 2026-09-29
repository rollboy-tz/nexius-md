import { Router } from 'express';
import { MessageController } from '../controllers/message.controller.js';

const router = Router();

/**
 * @route POST /api/v1/messages/send
 * @desc Dispatch outbound WhatsApp message (Text, Image, Sticker)
 * @access Private / API
 */
router.post('/send', MessageController.handleSendMessage);

export default router;