// The bridge's own database (never chat.db): paired devices, the secret that signs
// media links, and thumbnail sizes.

import { DatabaseSync } from 'node:sqlite';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export interface Device {
  id: number;
  name: string;
  createdAt: number;
  lastSeenAt: number | null;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** Media links stay valid this long; the client refreshes its token well before. */
export const MEDIA_TOKEN_TTL_MS = 24 * 60 * 60_000;

export class Store {
  #db: DatabaseSync;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.#db = new DatabaseSync(join(dataDir, 'app.db'));
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS devices (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS media_meta (
        attachment_id TEXT PRIMARY KEY,
        width INTEGER NOT NULL,
        height INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS seen (
        chat_guid TEXT PRIMARY KEY,
        up_to_row_id INTEGER NOT NULL,
        at INTEGER NOT NULL
      );
    `);
  }

  /** Bumped whenever a seen marker moves, so cached unread counts can be recomputed. */
  seenVersion = 0;

  /**
   * Marks a conversation seen up to a chat.db message ROWID. Messages.app can't be told
   * to mark it read, so the bridge keeps its own marker; it only ever moves forward.
   * Returns whether it moved.
   */
  markSeen(chatGuid: string, upToRowId: number, now = Date.now()): boolean {
    const { changes } = this.#db
      .prepare(
        `INSERT INTO seen (chat_guid, up_to_row_id, at) VALUES (?, ?, ?)
         ON CONFLICT (chat_guid) DO UPDATE SET up_to_row_id = excluded.up_to_row_id, at = excluded.at
         WHERE excluded.up_to_row_id > seen.up_to_row_id`,
      )
      .run(chatGuid, upToRowId, now);
    const moved = Number(changes) > 0;
    if (moved) this.seenVersion++;
    return moved;
  }

  /** {"<chat guid>": upToRowId, …} for chat.db's json_each(). */
  seenJson(): string {
    const rows = this.#db.prepare('SELECT chat_guid AS guid, up_to_row_id AS upTo FROM seen').all() as {
      guid: string;
      upTo: number;
    }[];
    return JSON.stringify(Object.fromEntries(rows.map((r) => [r.guid, r.upTo])));
  }

  #setting(key: string, create: () => string): string {
    const row = this.#db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    if (row) return row.value;
    const value = create();
    this.#db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run(key, value);
    return (this.#db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string }).value;
  }

  #mediaSecret(): Buffer {
    return Buffer.from(this.#setting('media_secret', () => randomBytes(32).toString('base64url')), 'base64url');
  }

  /** "<deviceId>.<expiresAt>.<hmac>", for ?t= on media URLs. */
  createMediaToken(deviceId: number, now = Date.now()): { token: string; expiresAt: number } {
    const expiresAt = now + MEDIA_TOKEN_TTL_MS;
    const payload = `${deviceId}.${expiresAt}`;
    const mac = createHmac('sha256', this.#mediaSecret()).update(payload).digest('base64url');
    return { token: `${payload}.${mac}`, expiresAt };
  }

  /** The device a media token belongs to, if the token is genuine, unexpired and the device still exists. */
  deviceForMediaToken(token: string, now = Date.now()): Device | null {
    const [deviceId, expiresAt, mac] = token.split('.');
    if (!deviceId || !expiresAt || !mac || Number(expiresAt) < now) return null;
    const expected = createHmac('sha256', this.#mediaSecret()).update(`${deviceId}.${expiresAt}`).digest();
    const actual = Buffer.from(mac, 'base64url');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
    const row = this.#db
      .prepare('SELECT id, name, created_at AS createdAt, last_seen_at AS lastSeenAt FROM devices WHERE id = ?')
      .get(Number(deviceId)) as Device | undefined;
    return row ? { ...row } : null;
  }

  mediaSize(attachmentId: string): { width: number; height: number } | null {
    const row = this.#db
      .prepare('SELECT width, height FROM media_meta WHERE attachment_id = ?')
      .get(attachmentId) as { width: number; height: number } | undefined;
    return row ? { ...row } : null;
  }

  setMediaSize(attachmentId: string, width: number, height: number) {
    this.#db
      .prepare('INSERT OR REPLACE INTO media_meta (attachment_id, width, height) VALUES (?, ?, ?)')
      .run(attachmentId, width, height);
  }

  /** Creates a device and returns its bearer token. Only the hash is stored. */
  createDevice(name: string): { device: Device; token: string } {
    const token = randomBytes(32).toString('base64url');
    const now = Date.now();
    const { lastInsertRowid } = this.#db
      .prepare('INSERT INTO devices (name, token_hash, created_at) VALUES (?, ?, ?)')
      .run(name, sha256(token), now);
    return { device: { id: Number(lastInsertRowid), name, createdAt: now, lastSeenAt: null }, token };
  }

  deviceForToken(token: string): Device | null {
    const row = this.#db
      .prepare(
        'SELECT id, name, created_at AS createdAt, last_seen_at AS lastSeenAt FROM devices WHERE token_hash = ?',
      )
      .get(sha256(token)) as Device | undefined;
    if (!row) return null;
    this.#db.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?').run(Date.now(), row.id);
    return { ...row };
  }

  listDevices(): Device[] {
    return this.#db
      .prepare('SELECT id, name, created_at AS createdAt, last_seen_at AS lastSeenAt FROM devices ORDER BY id')
      .all() as unknown as Device[];
  }

  revokeDevice(id: number): boolean {
    return Number(this.#db.prepare('DELETE FROM devices WHERE id = ?').run(id).changes) > 0;
  }
}
