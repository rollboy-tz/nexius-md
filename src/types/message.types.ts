// path: src/types/message.types.ts

/** WhatsApp formatting kinds we recognise. Positions are UTF-16 indices into the RAW text, markers included. */
export type FormatEntityType = 'bold' | 'italic' | 'strike' | 'code' | 'codeblock' | 'quote' | 'bullet' | 'number';

export interface FormatEntity {
  type: FormatEntityType;
  start: number;
  /** Exclusive. */
  end: number;
}

/** A message after cleaning. `text` is lossless: every marker the sender typed is still there. */
export interface ParsedMessage {
  text: string;
  entities: FormatEntity[];
  /** Normalised http(s) links found in the text, de-duplicated. */
  links: string[];
  /** Phone numbers mentioned as @255712345678 (digits only). */
  mentions: string[];
}

/** Image/sticker facts. The bytes are not stored in this version; `storageKey` is reserved for object storage. */
export interface MessageMedia {
  type: 'image' | 'sticker';
  mimetype: string | null;
  sizeBytes: number | null;
  width: number | null;
  height: number | null;
  sha256: string | null;
  caption: string | null;
  /** Outbound only: the https URL the image is fetched from at send time. */
  sourceUrl: string | null;
  storageKey: string | null;
}

export type OutboundMessageKind = 'TEXT' | 'IMAGE' | 'STATUS_TEXT' | 'STATUS_IMAGE';

export type OutboundContent =
  | { kind: 'TEXT'; text: string }
  | { kind: 'IMAGE'; imageUrl: string; caption?: string | undefined }
  | { kind: 'STATUS_TEXT'; text: string }
  | { kind: 'STATUS_IMAGE'; imageUrl: string; caption?: string | undefined };

/** Who can see a posted status. WhatsApp requires an explicit list of people. */
export interface StatusAudience {
  mode: 'RECENT_CONTACTS' | 'LIST';
  /** RECENT_CONTACTS: people who wrote to this number within this many days. */
  days?: number | undefined;
  max?: number | undefined;
  /** LIST: explicit user JIDs. */
  jids?: string[] | undefined;
}

/** Extras stored with a queued message (jsonb). */
export interface OutboundPayload {
  audience?: StatusAudience | undefined;
  backgroundColor?: string | undefined;
  font?: number | undefined;
}