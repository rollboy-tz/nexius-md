// path: src/services/humanizer.service.ts

import type { WASocket } from '@whiskeysockets/baileys';

/**
 * Human-like timing. Two ideas matter more than any single number:
 *
 *  1. NO FIXED PATTERNS. A constant 3.2 s typing time on every message is easier to detect than a
 *     fast one. Every delay here is drawn from a distribution, so no two sends look alike.
 *  2. Different jobs, different habits. Typing a reply, pasting a prepared announcement, and glancing
 *     at someone's status are not the same behaviour, and are not timed the same way.
 *
 * Note: this lowers risk, it does not remove it. Volume, who you message and how they react
 * (reports, blocks) matter far more. See outbound-policy.service.ts.
 */

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

export class HumanizerService {
  /** Replaceable in tests so timing can be made deterministic. */
  public static random: () => number = Math.random;

  /** Uniform integer in [min, max]. */
  public static between(min: number, max: number): number {
    return Math.floor(this.random() * (max - min + 1)) + min;
  }

  /** base ± fraction. jitter(1000, 0.2) is somewhere in 800..1200. */
  public static jitter(base: number, fraction = 0.2): number {
    return Math.round(base * (1 + (this.random() * 2 - 1) * fraction));
  }

  /** Bell-shaped random number (Box-Muller). */
  private static gaussian(mean: number, standardDeviation: number): number {
    const u = Math.max(this.random(), Number.EPSILON);
    const v = this.random();
    return mean + standardDeviation * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  /** Mostly near the median, with an occasional long tail. How real waiting times look. */
  private static logNormal(median: number, sigma: number): number {
    return median * Math.exp(this.gaussian(0, sigma));
  }

  public static shouldAct(probability: number): boolean {
    return this.random() < clamp(probability, 0, 1);
  }

  public static sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /* -------------------------------- timings -------------------------------- */

  /** Time to read what the other person wrote: about 3 to 4 words a second, never instant. */
  public static calculateReadingDelay(incomingText = ''): number {
    const words = incomingText.trim() === '' ? 0 : incomingText.trim().split(/\s+/).length;
    const base = words === 0 ? this.between(900, 2200) : (words / 3.5) * 1000;
    return Math.round(clamp(this.jitter(base, 0.3), 1200, 9000));
  }

  /**
   * Time to compose the message.
   *  - typed by hand: about 150 to 250 ms per character, with natural variation
   *  - pasted (a prepared announcement): a short pause, because nobody types a template out
   */
  public static calculateTypingDuration(text: string, pasted = false): number {
    if (pasted) return this.between(1200, 3500);

    const perCharacter = this.logNormal(170, 0.25);
    return Math.round(clamp(900 + text.length * perCharacter, 1800, 14_000));
  }

  /** A short beat between "stop typing" and the send button. */
  public static preSendPause(): number {
    return this.between(350, 1100);
  }

  /**
   * Gap before the next message goes out from the same number. Mostly short, sometimes a real
   * break, like a person who gets distracted. Used by the policy after every send.
   */
  public static gapBetweenMessages(isGroup: boolean): number {
    const [min, max] = isGroup ? [12_000, 38_000] : [7_000, 24_000];
    return this.between(min, max);
  }

  public static breakDuration(): number {
    return this.between(90_000, 360_000);
  }

  /**
   * How long after someone posts a status before we look at it: from a couple of minutes up to hours,
   * clustered toward the shorter end but with a long tail. Not "instantly", and not predictable.
   */
  public static statusViewDelayMs(minMinutes: number, maxMinutes: number): number {
    const minMs = minMinutes * 60_000;
    const maxMs = Math.max(maxMinutes * 60_000, minMs + 60_000);
    const median = minMs + (maxMs - minMs) * 0.25;
    return Math.round(clamp(this.logNormal(median, 0.9), minMs, maxMs));
  }

  /** How long to wait before marking a chat as read (blue ticks), longer for groups. */
  public static readReceiptDelayMs(isGroup: boolean): number {
    return isGroup ? this.between(30_000, 600_000) : this.between(4_000, 75_000);
  }

  /** Whether to mark a chat as read at all. People do not read everything. */
  public static shouldSendReadReceipt(isGroup: boolean): boolean {
    return this.shouldAct(isGroup ? 0.4 : 0.85);
  }

  /* ------------------------------ presence ------------------------------ */

  /**
   * Shows "typing…" for a believable time, then stops. Presence is cosmetic: a failure here must
   * never block or fail the message, so errors are swallowed.
   */
  public static async simulateHumanTyping(
    sock: WASocket,
    jid: string,
    outgoingText: string,
    options: { incomingText?: string | undefined; pasted?: boolean | undefined } = {},
  ): Promise<void> {
    try {
      // Reading time exists only when there is something to react to (a reply).
      if (options.incomingText !== undefined) {
        await this.sleep(this.calculateReadingDelay(options.incomingText));
      }

      await sock.presenceSubscribe(jid);
      await this.sleep(this.between(300, 800));
      await sock.sendPresenceUpdate('composing', jid);
      await this.sleep(this.calculateTypingDuration(outgoingText, options.pasted === true));
      await sock.sendPresenceUpdate('paused', jid);
      await this.sleep(this.preSendPause());
    } catch (error) {
      console.warn(`⚠️ [Humanizer] Presence simulation skipped: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
  }
}