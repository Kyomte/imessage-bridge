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
  /** False when the file isn't (fully) downloaded on the Mac. */
  available: boolean;
  isSticker: boolean;
  /** Display size of the thumbnail when already known, so the layout doesn't jump. */
  width: number | null;
  height: number | null;
}

export interface MediaToken {
  /** Append as ?t= to /api/attachments URLs (img/video tags can't send headers). */
  token: string;
  expiresAt: number;
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

/** 'waiting': the macOS permission prompt is probably open on the Mac. */
export type AutomationState = 'unknown' | 'checking' | 'granted' | 'denied' | 'waiting' | 'error';

export interface Health {
  chatDb: { ok: boolean; lastRowId: number | null };
  contacts: { count: number };
  messagesAppRunning: boolean;
  automation: { state: AutomationState; checkedAt: number | null };
  watcher: WatcherStats;
  liveClients: number;
  uptimeSeconds: number;
}

/** Sent with 503 from every API route while the server can't read chat.db. */
export const NEEDS_FULL_DISK_ACCESS = 'needs-full-disk-access';

/**
 * Progress of a send from this app. 'sending' covers the osascript call and the wait
 * for Messages to write the row; 'unconfirmed' means no row showed up in time (the
 * message may still have gone out).
 */
export type SendState = 'queued' | 'sending' | 'sent' | 'failed' | 'unconfirmed';

export interface SendStatus {
  clientId: string;
  conversationId: string;
  state: SendState;
  /** guid of the chat.db message once matched. */
  messageId: string | null;
  error: string | null;
}

export interface SendRequest {
  text: string;
  /** Client-generated id; resending the same id doesn't send twice. */
  clientId: string;
}

// WebSocket protocol at /api/ws. The client authenticates with its first frame,
// because a browser WebSocket can't send an Authorization header.

export type ServerEvent =
  /** clientBuild: file name of the client bundle the server currently serves, to spot stale pages. */
  | { type: 'hello'; lastRowId: number; serverTime: number; clientBuild: string | null }
  | { type: 'message.new'; message: Message }
  | { type: 'message.updated'; message: Message }
  | { type: 'conversation.updated'; conversation: ConversationSummary }
  | { type: 'send.status'; status: SendStatus }
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
