// src/services/humanizer.service.ts
import type { WASocket } from '@whiskeysockets/baileys';

export class HumanizerService {
  /**
   * Generates a random delay between min and max milliseconds.
   */
  static getRandomDelay(minMs: number, maxMs: number): number {
    return Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  }

  /**
   * Calculates time required for a human to READ an incoming message.
   * Average reading speed: ~200-250 words per minute (~3-4 words per second).
   *
   * @param {string} incomingText - The text received from client.
   * @returns {number} Delay in milliseconds (Capped between 1.2s to 6s).
   */
  static calculateReadingDelay(incomingText: string = ''): number {
    if (!incomingText || incomingText.trim() === '') {
      return this.getRandomDelay(1000, 2000);
    }
    const words = incomingText.trim().split(/\s+/).length;
    const readingTimeMs = Math.floor((words / 3.5) * 1000);
    return Math.min(Math.max(readingTimeMs, 1200), 6000);
  }

  /**
   * Calculates typing duration dynamically based on output character count.
   */
  static calculateTypingDuration(text: string): number {
    const chars = text.length;
    const calculatedMs = 1500 + chars * 45;
    return Math.min(Math.max(calculatedMs, 2000), 8000);
  }

  /**
   * Simulates dynamic human reading pause followed by typing status.
   */
  static async simulateHumanTyping(
    sock: WASocket,
    jid: string,
    outgoingText: string = '',
    incomingText: string = ''
  ): Promise<void> {
    try {
      // 1. Reading Time (Muda wa kusoma ujumbe wa mteja)
      const readingDelay = this.calculateReadingDelay(incomingText);
      await new Promise((resolve) => setTimeout(resolve, readingDelay));

      // 2. State: Composing (typing...)
      await sock.sendPresenceUpdate('composing', jid);

      // 3. Typing Duration (Muda wa kuandika jibu)
      const typingDuration = this.calculateTypingDuration(outgoingText);
      await new Promise((resolve) => setTimeout(resolve, typingDuration));

      // 4. State: Paused
      await sock.sendPresenceUpdate('paused', jid);

      // 5. Short pause before hit send button
      const preSendPause = this.getRandomDelay(400, 1000);
      await new Promise((resolve) => setTimeout(resolve, preSendPause));
    } catch (error) {
      console.warn(`⚠️ [Humanizer] Failed to simulate presence for ${jid}:`, error);
    }
  }
}