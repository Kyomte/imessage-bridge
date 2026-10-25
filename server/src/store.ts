// The bridge's own database (never chat.db): paired devices for now; the send
// outbox and media cache index land here in later milestones.

import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export interface Device {
  id: number;
  name: string;
  createdAt: number;
  lastSeenAt: number | null;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

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
    `);
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
