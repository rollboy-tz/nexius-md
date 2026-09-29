// src/controllers/message.controller.ts
import type { Request, Response, NextFunction } from 'express';
import { outboundMessageSchema } from '../schemas/message.schema.js';
import { MessageService } from '../services/message.service.js';
import type { WASocket } from '@whiskeysockets/baileys';
import type { OutboundMessagePayload } from '../types/message.types.js';

export class MessageController {
  /**
   * Express Handler to validate and send outbound messages via API.
   */
  static async handleSendMessage(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const validated = outboundMessageSchema.parse(req.body);

      const sock = (req as Request & { whatsappSocket?: WASocket }).whatsappSocket;
      if (!sock) {
        res.status(400).json({ success: false, message: 'Active WhatsApp session required' });
        return;
      }

      // Type-safe conversion for exactOptionalPropertyTypes
      const payload: OutboundMessagePayload = JSON.parse(JSON.stringify(validated));

      const result = await MessageService.sendMessage(sock, payload);

      res.status(200).json({
        success: true,
        message: 'Message dispatched successfully',
        data: { messageId: result?.key?.id }
      });
    } catch (error) {
      next(error);
    }
  }
}