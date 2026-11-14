// Where uploads from Windows wait for Messages to send them.
//
// Messages only sends files from inside ~/Library/Messages/Attachments (elsewhere it
// sends an empty message), and the attachment row it writes keeps pointing at the
// staged file instead of copying it. So a file that was sent must stay where it is:
// only folders that no chat.db attachment refers to are ever deleted.

import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';

const DAY_MS = 24 * 60 * 60_000;
const MAX_NAME_BYTES = 200;
/** Staged folders are 16 hex characters; anything else in the root isn't ours to delete. */
const FOLDER = /^[0-9a-f]{16}$/;

function truncateBytes(text: string, maxBytes: number): string {
  let out = '';
  for (const char of text) {
    if (Buffer.byteLength(out + char) > maxBytes) break;
    out += char;
  }
  return out;
}

/**
 * A file name that is safe on disk and still looks like the original, since Messages
 * shows it to the recipient: no folders, control characters or leading dots.
 */
export function safeName(original: string): string {
  let name = (original.split(/[\\/]/).pop() ?? '')
    .replace(/[\x00-\x1f\x7f:]/g, '')
    .replace(/^[.\s]+/, '')
    .trim();
  if (Buffer.byteLength(name) > MAX_NAME_BYTES) {
    const ext = truncateBytes(extname(name), 16);
    name = truncateBytes(name.slice(0, name.length - extname(name).length), MAX_NAME_BYTES - Buffer.byteLength(ext)) + ext;
  }
  return name || 'attachment';
}

export interface StagedFile {
  /** The file's own folder; the random folder name keeps every staged name unique. */
  dir: string;
  path: string;
  name: string;
}

export class Staging {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  create(originalName: string): StagedFile {
    const dir = join(this.root, randomBytes(8).toString('hex'));
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const name = safeName(originalName);
    return { dir, path: join(dir, name), name };
  }

  /** Deletes one staged folder (only ever one of ours). */
  remove(dir: string) {
    const target = resolve(dir);
    if (!target.startsWith(this.root + sep) || !FOLDER.test(target.slice(this.root.length + 1))) return;
    rmSync(target, { recursive: true, force: true });
  }

  /**
   * Deletes staged folders older than maxAgeMs that no attachment refers to: sends that
   * failed or never showed up in chat.db. Returns how many were deleted.
   */
  sweep(referencedDirs: Set<string>, { maxAgeMs = DAY_MS, now = Date.now() } = {}): number {
    let names: string[];
    try {
      names = readdirSync(this.root);
    } catch {
      return 0; // Nothing staged yet.
    }
    let removed = 0;
    for (const name of names) {
      if (!FOLDER.test(name)) continue;
      const dir = join(this.root, name);
      try {
        if (now - statSync(dir).mtimeMs < maxAgeMs) continue;
      } catch {
        continue;
      }
      if (referencedDirs.has(dir)) continue;
      rmSync(dir, { recursive: true, force: true });
      removed++;
    }
    return removed;
  }
}
