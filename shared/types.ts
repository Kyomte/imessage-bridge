// API shapes shared by server and client. Timestamps are Unix milliseconds.

export interface Participant {
  handle: string;
  /** Contact name, if the handle is in Contacts. */
  name: string | null;
  /** Name, or a formatted phone number / email / short code. */
  display: string;
}

export interface ConversationSummary {
  /** chat.guid, e.g. "any;-;+639171234567". URL-encode it in paths. */
  id: string;
  isGroup: boolean;
  title: string;
  service: string;
  participants: Participant[];
  lastMessage: {
    text: string;
    fromMe: boolean;
    at: number;
    hasAttachments: boolean;
  };
  unreadCount: number;
}

export type AttachmentKind = 'image' | 'video' | 'audio' | 'file';

export interface AttachmentInfo {
  id: string;
  name: string;
  mimeType: string | null;
  kind: AttachmentKind;
  size: number;
  /** False when the file isn't downloaded on the Mac. */
  available: boolean;
  isSticker: boolean;
}

export interface Message {
  id: string;
  rowId: number;
  conversationId: string;
  fromMe: boolean;
  /** Null for messages you sent. */
  sender: Participant | null;
  text: string;
  sentAt: number;
  /** Messages sent from other devices are often flagged delivered with no delivery time. */
  delivered: boolean;
  deliveredAt: number | null;
  readAt: number | null;
  editedAt: number | null;
  retracted: boolean;
  /** guid of the message this is an inline reply to. */
  replyToId: string | null;
  service: string;
  error: number;
  attachments: AttachmentInfo[];
}

export interface MessagePage {
  /** Oldest first. */
  messages: Message[];
  /** Pass as ?before= to load older messages; null at the start of history. */
  nextCursor: string | null;
}

export interface PairResponse {
  token: string;
  deviceId: number;
}

export interface WatcherStats {
  checks: number;
  changes: number;
  /** Which trigger noticed each change first. */
  triggers: { fsevents: number; poll: number; manual: number };
  lastChangeAt: number | null;
  /** Detection time minus send time of the newest message in the last batch. */
  lastLatencyMs: number | null;
}

export interface Health {
  chatDb: { ok: boolean; lastRowId: number | null };
  contacts: { count: number };
  messagesAppRunning: boolean;
  watcher: WatcherStats;
  liveClients: number;
}

// WebSocket protocol at /api/ws. The client authenticates with its first frame,
// because a browser WebSocket can't send an Authorization header.

export type ServerEvent =
  | { type: 'hello'; lastRowId: number; serverTime: number }
  | { type: 'message.new'; message: Message }
  | { type: 'message.updated'; message: Message }
  | { type: 'conversation.updated'; conversation: ConversationSummary }
  /** Too much was missed to replay; refetch everything. */
  | { type: 'resync' };

export type ClientEvent =
  | { type: 'auth'; token: string }
  /** Replay messages newer than this rowId (after a reconnect). */
  | { type: 'resume'; sinceRowId: number };

/** WebSocket close codes used by the server. */
export const CLOSE_UNAUTHORIZED = 4401;
export const CLOSE_FORBIDDEN_ORIGIN = 4403;
export const CLOSE_BAD_MESSAGE = 4400;
