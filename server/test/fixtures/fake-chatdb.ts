// A minimal chat.db with the tables and columns the server reads, written through a
// separate connection the way Messages.app does (so PRAGMA data_version changes).

import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APPLE_EPOCH_MS = 978_307_200_000;

export const appleNs = (unixMs: number) => BigInt(unixMs - APPLE_EPOCH_MS) * 1_000_000n;

export class FakeChatDb {
  dir = mkdtempSync(join(tmpdir(), 'imb-chatdb-'));
  path = join(this.dir, 'chat.db');
  #db: DatabaseSync;
  #guid = 0;

  constructor() {
    this.#db = new DatabaseSync(this.path);
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
      CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, guid TEXT UNIQUE, style INTEGER, display_name TEXT,
        service_name TEXT, chat_identifier TEXT);
      CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER);
      CREATE TABLE message (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT UNIQUE, text TEXT,
        attributedBody BLOB, handle_id INTEGER DEFAULT 0, service TEXT DEFAULT 'iMessage',
        date INTEGER DEFAULT 0, date_read INTEGER DEFAULT 0, date_delivered INTEGER DEFAULT 0,
        date_edited INTEGER DEFAULT 0, date_retracted INTEGER DEFAULT 0, is_from_me INTEGER DEFAULT 0,
        is_read INTEGER DEFAULT 0, is_delivered INTEGER DEFAULT 0, error INTEGER DEFAULT 0,
        cache_has_attachments INTEGER DEFAULT 0, thread_originator_guid TEXT,
        associated_message_type INTEGER DEFAULT 0, item_type INTEGER DEFAULT 0);
      CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER, message_date INTEGER);
      CREATE TABLE attachment (ROWID INTEGER PRIMARY KEY, guid TEXT, transfer_name TEXT, filename TEXT,
        mime_type TEXT, total_bytes INTEGER, is_sticker INTEGER DEFAULT 0, hide_attachment INTEGER DEFAULT 0,
        transfer_state INTEGER DEFAULT 5);
      CREATE TABLE message_attachment_join (message_id INTEGER, attachment_id INTEGER);
    `);
  }

  addChat(
    handleId: string,
    opts: { service?: string; guid?: string } = {},
  ): { chatRowId: number; guid: string; handleRowId: number } {
    const handleRowId = Number(this.#db.prepare('INSERT INTO handle (id) VALUES (?)').run(handleId).lastInsertRowid);
    const guid = opts.guid ?? `any;-;${handleId}`;
    const chatRowId = Number(
      this.#db
        .prepare('INSERT INTO chat (guid, style, service_name, chat_identifier) VALUES (?, 45, ?, ?)')
        .run(guid, opts.service ?? 'iMessage', handleId).lastInsertRowid,
    );
    this.#db.prepare('INSERT INTO chat_handle_join VALUES (?, ?)').run(chatRowId, handleRowId);
    return { chatRowId, guid, handleRowId };
  }

  /** Inserts a message; pass chatRowId null to leave it unlinked. Returns its ROWID. */
  addMessage(
    chatRowId: number | null,
    opts: { text?: string; fromMe?: boolean; handleRowId?: number; at?: number; tapback?: boolean } = {},
  ): number {
    const date = appleNs(opts.at ?? Date.now());
    const rowId = Number(
      this.#db
        .prepare(
          `INSERT INTO message (guid, text, handle_id, date, is_from_me, associated_message_type)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(`msg-${++this.#guid}`, opts.text ?? 'hi', opts.fromMe ? 0 : (opts.handleRowId ?? 0), date,
          opts.fromMe ? 1 : 0, opts.tapback ? 2000 : 0).lastInsertRowid,
    );
    if (chatRowId != null) this.link(chatRowId, rowId);
    return rowId;
  }

  link(chatRowId: number, messageRowId: number) {
    this.#db.prepare('INSERT INTO chat_message_join VALUES (?, ?, 0)').run(chatRowId, messageRowId);
  }

  markDelivered(rowId: number, at = Date.now()) {
    this.#db.prepare('UPDATE message SET is_delivered = 1, date_delivered = ? WHERE ROWID = ?').run(appleNs(at), rowId);
  }

  markRead(rowId: number, at = Date.now()) {
    this.#db.prepare('UPDATE message SET is_read = 1, date_read = ? WHERE ROWID = ?').run(appleNs(at), rowId);
  }

  edit(rowId: number, text: string, at = Date.now()) {
    this.#db.prepare('UPDATE message SET text = ?, date_edited = ? WHERE ROWID = ?').run(text, appleNs(at), rowId);
  }

  /** Adds an attachment to a message; returns its guid. */
  addAttachment(
    messageRowId: number,
    opts: { filename: string | null; mimeType?: string | null; name?: string; sticker?: boolean; transferState?: number },
  ): string {
    const guid = `att-${++this.#guid}`;
    const attachmentRowId = Number(
      this.#db
        .prepare(
          `INSERT INTO attachment (guid, transfer_name, filename, mime_type, total_bytes, is_sticker, transfer_state)
           VALUES (?, ?, ?, ?, 0, ?, ?)`,
        )
        .run(guid, opts.name ?? opts.filename?.split('/').at(-1) ?? null, opts.filename, opts.mimeType ?? null,
          opts.sticker ? 1 : 0, opts.transferState ?? 5).lastInsertRowid,
    );
    this.#db.prepare('INSERT INTO message_attachment_join VALUES (?, ?)').run(messageRowId, attachmentRowId);
    this.#db.prepare('UPDATE message SET cache_has_attachments = 1 WHERE ROWID = ?').run(messageRowId);
    return guid;
  }

  setTransferState(attachmentGuid: string, state: number) {
    this.#db.prepare('UPDATE attachment SET transfer_state = ? WHERE guid = ?').run(state, attachmentGuid);
  }

  setError(rowId: number, error = 22) {
    this.#db.prepare('UPDATE message SET error = ? WHERE ROWID = ?').run(error, rowId);
  }

  close() {
    this.#db.close();
    rmSync(this.dir, { recursive: true, force: true });
  }
}
