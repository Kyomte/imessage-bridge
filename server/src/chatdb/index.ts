// Read-only access to ~/Library/Messages/chat.db. Never opened for writing.

import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { extname } from 'node:path';
import type {
  AttachmentInfo,
  AttachmentKind,
  ConversationSummary,
  Message,
  MessagePage,
  Participant,
} from '@imb/shared';
import { decodeAttributedBody } from './decode.ts';
import { formatHandle, type Contacts } from '../contacts.ts';

const APPLE_EPOCH_MS = 978_307_200_000;
const GROUP_STYLE = 43;
const MAX_INT64 = 9_223_372_036_854_775_807n;

/** Apple ns dates (~8e17) overflow JS numbers and node:sqlite throws, so convert in SQL. */
const ms = (col: string) => `CASE WHEN ${col} > 0 THEN ${col} / 1000000 + ${APPLE_EPOCH_MS} END`;

/** Normal timeline rows: no tapbacks, no system rows (renames, member changes). */
const VISIBLE = 'm.associated_message_type = 0 AND m.item_type = 0';

export function messageText(text: string | null, body: Uint8Array | null): string {
  const raw = (body ? decodeAttributedBody(body) : null) ?? text ?? '';
  // U+FFFC marks where an attachment sits inline; attachments are listed separately.
  return raw.replaceAll('￼', '').trim();
}

const EXT_KIND: Record<string, AttachmentKind> = {
  '.heic': 'image', '.heif': 'image', '.jpg': 'image', '.jpeg': 'image', '.png': 'image',
  '.gif': 'image', '.webp': 'image', '.tiff': 'image',
  '.mov': 'video', '.mp4': 'video', '.m4v': 'video',
  '.caf': 'audio', '.m4a': 'audio', '.mp3': 'audio', '.amr': 'audio',
};

export function attachmentKind(mimeType: string | null, name: string): AttachmentKind {
  const top = mimeType?.split('/')[0];
  if (top === 'image' || top === 'video' || top === 'audio') return top;
  return EXT_KIND[extname(name).toLowerCase()] ?? 'file';
}

export const expandHome = (path: string) => (path.startsWith('~/') ? homedir() + path.slice(1) : path);

interface ConversationRow {
  chatRowId: number;
  guid: string;
  style: number;
  displayName: string | null;
  service: string | null;
  identifier: string | null;
  lastAt: number;
  lastFromMe: number;
  lastText: string | null;
  lastBody: Uint8Array | null;
  lastHasAttachments: number;
  lastRetracted: number;
  unread: number | null;
}

interface MessageRow {
  rowId: number;
  id: string;
  dateNs: string;
  fromMe: number;
  sentAt: number;
  delivered: number;
  deliveredAt: number | null;
  readAt: number | null;
  editedAt: number | null;
  retracted: number;
  text: string | null;
  body: Uint8Array | null;
  service: string | null;
  error: number;
  hasAttachments: number;
  replyToId: string | null;
  handle: string | null;
}

interface AttachmentRow {
  messageRowId: number;
  id: string;
  name: string | null;
  path: string | null;
  mimeType: string | null;
  size: number | null;
  isSticker: number;
}

export class ChatDb {
  #db: DatabaseSync;
  #contacts: Contacts;
  #region: string;
  #cache: { version: number; conversations: ConversationSummary[] } | null = null;

  constructor(path: string, contacts: Contacts, region: string) {
    this.#db = new DatabaseSync(path, { readOnly: true });
    this.#contacts = contacts;
    this.#region = region;
  }

  /** Changes whenever another connection (Messages.app) commits. */
  dataVersion(): number {
    return (this.#db.prepare('PRAGMA data_version').get() as { data_version: number }).data_version;
  }

  lastRowId(): number | null {
    return (this.#db.prepare('SELECT MAX(ROWID) AS id FROM message').get() as { id: number | null }).id;
  }

  participant(handle: string): Participant {
    const name = this.#contacts.nameFor(handle);
    return { handle, name, display: name ?? formatHandle(handle, this.#region) };
  }

  listConversations(): ConversationSummary[] {
    const version = this.dataVersion();
    if (this.#cache?.version === version) return this.#cache.conversations;
    const conversations = this.#queryConversations();
    this.#cache = { version, conversations };
    return conversations;
  }

  getConversation(id: string): ConversationSummary | null {
    return this.listConversations().find((c) => c.id === id) ?? null;
  }

  #queryConversations(): ConversationSummary[] {
    const rows = this.#db
      .prepare(
        `WITH visible AS (
           SELECT cmj.chat_id, m.ROWID AS mid, m.date, m.is_read, m.is_from_me
           FROM chat_message_join cmj JOIN message m ON m.ROWID = cmj.message_id
           WHERE ${VISIBLE}
         ),
         ranked AS (
           SELECT chat_id, mid, ROW_NUMBER() OVER (PARTITION BY chat_id ORDER BY date DESC, mid DESC) AS rn
           FROM visible
         ),
         unread AS (
           SELECT chat_id, SUM(is_read = 0 AND is_from_me = 0) AS n FROM visible GROUP BY chat_id
         )
         SELECT c.ROWID AS chatRowId, c.guid, c.style, c.display_name AS displayName,
                c.service_name AS service, c.chat_identifier AS identifier,
                ${ms('m.date')} AS lastAt, m.is_from_me AS lastFromMe, m.text AS lastText,
                m.attributedBody AS lastBody, m.cache_has_attachments AS lastHasAttachments,
                m.date_retracted > 0 AS lastRetracted, u.n AS unread
         FROM chat c
         JOIN ranked r ON r.chat_id = c.ROWID AND r.rn = 1
         JOIN message m ON m.ROWID = r.mid
         LEFT JOIN unread u ON u.chat_id = c.ROWID
         ORDER BY m.date DESC`,
      )
      .all() as unknown as ConversationRow[];

    const handlesByChat = new Map<number, string[]>();
    const handleRows = this.#db
      .prepare(
        `SELECT chj.chat_id AS chatRowId, h.id AS handle
         FROM chat_handle_join chj JOIN handle h ON h.ROWID = chj.handle_id
         ORDER BY chj.chat_id, h.ROWID`,
      )
      .all() as { chatRowId: number; handle: string }[];
    for (const { chatRowId, handle } of handleRows) {
      const list = handlesByChat.get(chatRowId) ?? [];
      if (!list.includes(handle)) list.push(handle);
      handlesByChat.set(chatRowId, list);
    }

    return rows.map((row) => {
      const isGroup = row.style === GROUP_STYLE;
      let handles = handlesByChat.get(row.chatRowId) ?? [];
      if (handles.length === 0 && row.identifier) handles = [row.identifier];
      const participants = handles.map((h) => this.participant(h));
      const title = isGroup
        ? row.displayName || participants.map((p) => p.name?.split(' ')[0] ?? p.display).join(', ')
        : participants[0]?.display ?? row.identifier ?? row.guid;
      return {
        id: row.guid,
        isGroup,
        title,
        service: row.service ?? 'iMessage',
        participants,
        lastMessage: {
          text: row.lastRetracted ? '' : messageText(row.lastText, row.lastBody),
          fromMe: row.lastFromMe === 1,
          at: row.lastAt,
          hasAttachments: row.lastHasAttachments === 1,
        },
        unreadCount: row.unread ?? 0,
      };
    });
  }

  /**
   * One page of a conversation, oldest first. `before` is an opaque cursor from a
   * previous page ("<apple date ns>:<rowid>"); omit it for the newest page.
   */
  listMessages(chatId: string, opts: { before?: string; limit?: number } = {}): MessagePage {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    let beforeDate = MAX_INT64;
    let beforeRowId = MAX_INT64;
    if (opts.before) {
      const [date, rowId] = opts.before.split(':');
      if (!/^\d+$/.test(date ?? '') || !/^\d+$/.test(rowId ?? '')) throw new Error('bad cursor');
      beforeDate = BigInt(date);
      beforeRowId = BigInt(rowId);
    }

    const rows = this.#db
      .prepare(
        `SELECT m.ROWID AS rowId, m.guid AS id, CAST(m.date AS TEXT) AS dateNs, m.is_from_me AS fromMe,
                ${ms('m.date')} AS sentAt, m.is_delivered AS delivered, ${ms('m.date_delivered')} AS deliveredAt,
                ${ms('m.date_read')} AS readAt, ${ms('m.date_edited')} AS editedAt,
                m.date_retracted > 0 AS retracted, m.text, m.attributedBody AS body, m.service,
                m.error, m.cache_has_attachments AS hasAttachments,
                m.thread_originator_guid AS replyToId, h.id AS handle
         FROM chat c
         JOIN chat_message_join cmj ON cmj.chat_id = c.ROWID
         JOIN message m ON m.ROWID = cmj.message_id
         LEFT JOIN handle h ON h.ROWID = m.handle_id
         WHERE c.guid = :chat AND ${VISIBLE} AND (m.date, m.ROWID) < (:beforeDate, :beforeRowId)
         ORDER BY m.date DESC, m.ROWID DESC
         LIMIT :limit`,
      )
      .all({ chat: chatId, beforeDate, beforeRowId, limit: limit + 1 }) as unknown as MessageRow[];

    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const oldest = page.at(-1);
    const attachments = this.#attachmentsFor(page.filter((r) => r.hasAttachments).map((r) => r.rowId));

    return {
      messages: page.reverse().map((row) => this.#toMessage(row, chatId, attachments.get(row.rowId) ?? [])),
      nextCursor: hasMore && oldest ? `${oldest.dateNs}:${oldest.rowId}` : null,
    };
  }

  #toMessage(row: MessageRow, conversationId: string, attachments: AttachmentInfo[]): Message {
    const fromMe = row.fromMe === 1;
    return {
      id: row.id,
      rowId: row.rowId,
      conversationId,
      fromMe,
      sender: !fromMe && row.handle ? this.participant(row.handle) : null,
      text: row.retracted ? '' : messageText(row.text, row.body),
      sentAt: row.sentAt,
      delivered: row.delivered === 1 || row.deliveredAt != null,
      deliveredAt: row.deliveredAt,
      readAt: row.readAt,
      editedAt: row.editedAt,
      retracted: row.retracted === 1,
      replyToId: row.replyToId,
      service: row.service ?? 'iMessage',
      error: row.error,
      attachments,
    };
  }

  #attachmentsFor(messageRowIds: number[]): Map<number, AttachmentInfo[]> {
    const byMessage = new Map<number, AttachmentInfo[]>();
    if (messageRowIds.length === 0) return byMessage;
    const rows = this.#db
      .prepare(
        `SELECT maj.message_id AS messageRowId, a.guid AS id, a.transfer_name AS name, a.filename AS path,
                a.mime_type AS mimeType, a.total_bytes AS size, a.is_sticker AS isSticker
         FROM message_attachment_join maj JOIN attachment a ON a.ROWID = maj.attachment_id
         WHERE maj.message_id IN (SELECT value FROM json_each(?)) AND a.hide_attachment = 0
         ORDER BY maj.message_id, a.ROWID`,
      )
      .all(JSON.stringify(messageRowIds)) as unknown as AttachmentRow[];
    for (const row of rows) {
      const name = row.name ?? row.path?.split('/').at(-1) ?? 'attachment';
      const info: AttachmentInfo = {
        id: row.id,
        name,
        mimeType: row.mimeType,
        kind: attachmentKind(row.mimeType, name),
        size: row.size ?? 0,
        available: row.path != null && existsSync(expandHome(row.path)),
        isSticker: row.isSticker === 1,
      };
      const list = byMessage.get(row.messageRowId) ?? [];
      list.push(info);
      byMessage.set(row.messageRowId, list);
    }
    return byMessage;
  }
}
