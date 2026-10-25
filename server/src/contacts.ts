// Maps message handles (phone numbers / emails) to Contacts names by reading the
// AddressBook SQLite stores directly (covered by Full Disk Access). Reloads when
// any store or its WAL changes, checked at most every 30 s.

import { DatabaseSync } from 'node:sqlite';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js';

const CHECK_INTERVAL_MS = 30_000;
const STORE_NAME = 'AddressBook-v22.abcddb';

export function normalizeHandle(handle: string, region: string): string {
  const trimmed = handle.trim();
  if (trimmed.includes('@')) return trimmed.toLowerCase();
  const phone = parsePhoneNumberFromString(trimmed, region as CountryCode);
  if (phone?.isValid()) return phone.number;
  return trimmed.replace(/[^\d+a-z]/gi, '').toLowerCase();
}

/** "+63 917 123 4567" for valid numbers; emails and short codes unchanged. */
export function formatHandle(handle: string, region: string): string {
  if (handle.includes('@')) return handle;
  const phone = parsePhoneNumberFromString(handle, region as CountryCode);
  return phone?.isValid() ? phone.formatInternational() : handle;
}

export class Contacts {
  #dir: string;
  #region: string;
  #names = new Map<string, string>();
  #signature = '';
  #checkedAt = 0;

  constructor(addressBookDir: string, region: string) {
    this.#dir = addressBookDir;
    this.#region = region;
  }

  get count(): number {
    this.#refreshIfChanged();
    return this.#names.size;
  }

  nameFor(handle: string): string | null {
    this.#refreshIfChanged();
    return this.#names.get(normalizeHandle(handle, this.#region)) ?? null;
  }

  #storePaths(): string[] {
    const paths = [join(this.#dir, STORE_NAME)];
    const sources = join(this.#dir, 'Sources');
    if (existsSync(sources)) {
      for (const source of readdirSync(sources)) paths.push(join(sources, source, STORE_NAME));
    }
    return paths.filter((p) => existsSync(p));
  }

  #refreshIfChanged() {
    const now = Date.now();
    if (now - this.#checkedAt < CHECK_INTERVAL_MS) return;
    this.#checkedAt = now;
    const paths = this.#storePaths();
    const signature = paths
      .flatMap((p) => [p, `${p}-wal`])
      .map((p) => (existsSync(p) ? `${p}:${statSync(p).mtimeMs}` : p))
      .join('|');
    if (signature === this.#signature) return;
    this.#signature = signature;
    this.#names = this.#load(paths);
  }

  #load(paths: string[]): Map<string, string> {
    const names = new Map<string, string>();
    for (const path of paths) {
      const db = new DatabaseSync(path, { readOnly: true });
      try {
        const people = new Map<number, string>();
        const records = db
          .prepare('SELECT Z_PK AS id, ZFIRSTNAME AS first, ZLASTNAME AS last, ZNICKNAME AS nick, ZORGANIZATION AS org FROM ZABCDRECORD')
          .all() as { id: number; first: string | null; last: string | null; nick: string | null; org: string | null }[];
        for (const r of records) {
          const full = [r.first, r.last].filter(Boolean).join(' ');
          const name = full || r.nick || r.org;
          if (name) people.set(r.id, name);
        }
        const handles = db
          .prepare(
            `SELECT ZOWNER AS owner, ZFULLNUMBER AS value FROM ZABCDPHONENUMBER
             UNION ALL SELECT ZOWNER, ZADDRESS FROM ZABCDEMAILADDRESS`,
          )
          .all() as { owner: number; value: string | null }[];
        for (const h of handles) {
          const name = people.get(h.owner);
          if (name && h.value) names.set(normalizeHandle(h.value, this.#region), name);
        }
      } finally {
        db.close();
      }
    }
    return names;
  }
}
