// path: src/utils/whatsapp-format.ts

import { createHash } from 'node:crypto';
import type { FormatEntity, ParsedMessage } from '../types/message.types.js';
import { ApiError } from './api.error.js';

export const MAX_MESSAGE_LENGTH = 4096;
export const MAX_CAPTION_LENGTH = 1024;

const MAX_LINKS = 20;
const MAX_MENTIONS = 50;
const MASK = '\u0000';

/**
 * Characters that never belong in a message people read:
 *  - zero-width space, word joiner, BOM: used to slip past filters and to make identical text look different
 *  - bidi overrides/isolates: make text display differently from what it contains (link spoofing)
 * Kept on purpose: ZWJ (U+200D) and ZWNJ (U+200C), because emoji sequences and several scripts need them.
 */
const UNSAFE_INVISIBLE = /[\u200B\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/g;
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/* ============================================================================
 * 1. Cleaning (what is allowed to be stored and sent)
 * ========================================================================== */

/**
 * Normalises text for storage and sending. It never touches formatting markers:
 * unbalanced or odd markers are valid in WhatsApp (they simply show as typed), so they are kept.
 * Throws only for input that cannot be a message (not text, empty, too long).
 */
export function normalizeMessageText(input: unknown, maxLength = MAX_MESSAGE_LENGTH): string {
  if (typeof input !== 'string') throw ApiError.badRequest('Message text must be text.', 'INVALID_MESSAGE_TEXT');

  const text = input
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(UNSAFE_INVISIBLE, '')
    .replace(CONTROL, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();

  if (text.length === 0) throw ApiError.badRequest('Message cannot be empty.', 'EMPTY_MESSAGE');
  if (text.length > maxLength) {
    throw ApiError.badRequest(`Message is too long (maximum ${maxLength} characters).`, 'MESSAGE_TOO_LONG');
  }

  return text;
}

/* ============================================================================
 * 2. Parsing
 *
 * WhatsApp rules, as implemented here:
 *   *bold*  _italic_  ~strike~   open after start/space/punctuation, close before space/punctuation/end,
 *                                content cannot start or end with a space, one line only
 *   `code`  inline code          ```block```  may span lines. Nothing inside code is formatted.
 *   > quote   - bullet   * bullet   1. numbered      at the start of a line
 * A marker that does not form a valid pair is just text, exactly as in the app.
 * ========================================================================== */

const isWordChar = (char: string): boolean => char !== '' && /[\p{L}\p{N}]/u.test(char);
const isSpace = (char: string): boolean => char === '' || /\s/.test(char);

const MARKERS: ReadonlyArray<{ char: string; type: 'bold' | 'italic' | 'strike' }> = [
  { char: '*', type: 'bold' },
  { char: '_', type: 'italic' },
  { char: '~', type: 'strike' },
];

/** Replaces code with placeholders of equal length, so marker scanning ignores it and indices stay valid. */
function maskRanges(raw: string, ranges: FormatEntity[]): string {
  let masked = raw;
  for (const range of ranges) {
    masked = masked.slice(0, range.start) + MASK.repeat(range.end - range.start) + masked.slice(range.end);
  }
  return masked;
}

function findCode(raw: string): FormatEntity[] {
  const found: FormatEntity[] = [];

  for (const match of raw.matchAll(/```([\s\S]+?)```/g)) {
    const start = match.index ?? 0;
    found.push({ type: 'codeblock', start, end: start + match[0].length });
  }

  const withoutBlocks = maskRanges(raw, found);
  for (const match of withoutBlocks.matchAll(/`([^`\n\u0000]+)`/g)) {
    const start = match.index ?? 0;
    found.push({ type: 'code', start, end: start + match[0].length });
  }

  return found;
}

function findPairs(masked: string, char: string, type: 'bold' | 'italic' | 'strike'): FormatEntity[] {
  const spans: FormatEntity[] = [];
  let i = 0;

  while (i < masked.length) {
    if (masked[i] !== char) {
      i += 1;
      continue;
    }

    const before = i === 0 ? '' : (masked[i - 1] ?? '');
    const after = masked[i + 1] ?? '';
    const canOpen = !isWordChar(before) && before !== char && !isSpace(after) && after !== char;

    if (!canOpen) {
      i += 1;
      continue;
    }

    let closeAt = -1;
    for (let j = i + 2; j < masked.length; j += 1) {
      const current = masked[j];
      if (current === '\n') break;
      if (current !== char) continue;

      const previous = masked[j - 1] ?? '';
      const next = masked[j + 1] ?? '';
      if (!isSpace(previous) && previous !== char && !isWordChar(next) && next !== char) {
        closeAt = j;
        break;
      }
    }

    if (closeAt === -1) {
      i += 1;
      continue;
    }

    spans.push({ type, start: i, end: closeAt + 1 });
    i = closeAt + 1;
  }

  return spans;
}

/** Keeps spans that nest or stand apart; drops the ones that cross (WhatsApp cannot render those either). */
function dropCrossing(spans: FormatEntity[]): FormatEntity[] {
  const ordered = [...spans].sort((a, b) => a.start - b.start || b.end - a.end);
  const kept: FormatEntity[] = [];

  for (const span of ordered) {
    const crosses = kept.some((other) => {
      const overlap = span.start < other.end && span.end > other.start;
      const nested = (span.start >= other.start && span.end <= other.end) || (other.start >= span.start && other.end <= span.end);
      return overlap && !nested;
    });
    if (!crosses) kept.push(span);
  }

  return kept;
}

function findLineEntities(raw: string, masked: string): FormatEntity[] {
  const entities: FormatEntity[] = [];
  let offset = 0;

  for (const line of raw.split('\n')) {
    const start = offset;
    const end = offset + line.length;
    offset = end + 1;

    if (line.length === 0 || masked[start] === MASK) continue;

    if (line.startsWith('>')) entities.push({ type: 'quote', start, end });
    else if (/^[-*]\s+\S/.test(line)) entities.push({ type: 'bullet', start, end });
    else if (/^\d{1,3}\.\s+\S/.test(line)) entities.push({ type: 'number', start, end });
  }

  return entities;
}

const TRAILING_PUNCTUATION = /[.,;:!?)\]}'"*_~]+$/;

function findLinks(raw: string): string[] {
  const links = new Set<string>();

  for (const match of raw.matchAll(/\b(?:https?:\/\/|www\.)[^\s<>"'`]+/gi)) {
    let candidate = match[0].replace(TRAILING_PUNCTUATION, '');
    if (/^www\./i.test(candidate)) candidate = `https://${candidate}`;

    try {
      const url = new URL(candidate);
      if ((url.protocol === 'https:' || url.protocol === 'http:') && url.hostname.includes('.') && candidate.length <= 2048) {
        links.add(url.toString());
      }
    } catch {
      // not a link after all
    }

    if (links.size >= MAX_LINKS) break;
  }

  return [...links];
}

function findMentions(raw: string): string[] {
  const numbers = new Set<string>();

  for (const match of raw.matchAll(/(?<![\p{L}\p{N}])@(\d{8,15})(?!\d)/gu)) {
    if (match[1]) numbers.add(match[1]);
    if (numbers.size >= MAX_MENTIONS) break;
  }

  return [...numbers];
}

/** Parses already-cleaned text. Pure and deterministic; the raw text is returned untouched. */
export function parseWhatsAppText(text: string): ParsedMessage {
  const code = findCode(text);
  const masked = maskRanges(text, code);

  const pairs = MARKERS.flatMap(({ char, type }) => findPairs(masked, char, type));
  const entities = dropCrossing([...code, ...pairs, ...findLineEntities(text, masked)]);

  return { text, entities, links: findLinks(text), mentions: findMentions(text) };
}

/** Clean, then parse. The one call used for everything that is stored or sent. */
export function prepareText(input: unknown, maxLength = MAX_MESSAGE_LENGTH): ParsedMessage {
  return parseWhatsAppText(normalizeMessageText(input, maxLength));
}

/* ============================================================================
 * 3. Helpers for saved messages and anti-duplicate checks
 * ========================================================================== */

/** Same words, different spacing/case still count as the same message when judging "identical content". */
export function contentFingerprint(text: string): string {
  const canonical = text.toLowerCase().replace(/\s+/g, ' ').trim();
  return createHash('sha256').update(canonical).digest('hex').slice(0, 32);
}

const VARIABLE_RE = /\{\{\s*([a-zA-Z_]\w{0,31})\s*\}\}/g;

export function findVariables(template: string): string[] {
  return [...new Set([...template.matchAll(VARIABLE_RE)].map((match) => match[1] ?? ''))].filter(Boolean);
}

/**
 * Fills {{name}} placeholders. Values are cleaned first; unknown placeholders become empty text.
 * Formatting characters inside a value are kept as given: WhatsApp has no escape character.
 */
export function renderVariables(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(VARIABLE_RE, (_whole, name: string) => {
    const value = values[name] ?? '';
    return value.normalize('NFC').replace(UNSAFE_INVISIBLE, '').replace(CONTROL, '').slice(0, 200);
  });
}