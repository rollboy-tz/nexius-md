// path: src/utils/jid.util.ts

import { ApiError } from './api.error.js';

const PHONE_RE = /^\d{8,15}$/;

export const STATUS_JID = 'status@broadcast';

/** Digits only, 8 to 15 long, or null. */
export function normalizePhoneNumber(value: string): string | null {
  const digits = value.replace(/\D/g, '');
  return PHONE_RE.test(digits) ? digits : null;
}

export const isGroupJid = (jid: string): boolean => jid.endsWith('@g.us');
export const isStatusJid = (jid: string): boolean => jid === STATUS_JID;
export const isUserJid = (jid: string): boolean => jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid');

export const phoneToJid = (phone: string): string => `${phone}@s.whatsapp.net`;

/**
 * Turns what a caller typed into a JID WhatsApp accepts, or rejects it. Never guesses.
 * Accepts: a phone number, a user JID (device suffix ignored), a group JID, a LID.
 * Rejects: newsletters, broadcasts, empty or malformed input.
 */
export function resolveRecipient(to: string): string {
  const raw = to.trim();
  const at = raw.indexOf('@');

  if (at === -1) {
    const phone = normalizePhoneNumber(raw);
    if (phone) return phoneToJid(phone);
  } else {
    // "2557...:12@s.whatsapp.net": what follows ':' is a device id, not part of the number.
    const user = raw.slice(0, at).split(':')[0] ?? '';
    const server = raw.slice(at + 1).toLowerCase();

    if (server === 'g.us' && /^[\d-]{5,40}$/.test(user)) return `${user}@g.us`;
    if (server === 'lid' && /^\d{5,30}$/.test(user)) return `${user}@lid`;
    if (server === 's.whatsapp.net' || server === 'c.us') {
      const phone = normalizePhoneNumber(user);
      if (phone) return phoneToJid(phone);
    }
  }

  throw ApiError.badRequest('Invalid recipient. Use a phone number with country code, or a group id.', 'INVALID_RECIPIENT');
}