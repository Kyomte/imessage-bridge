// Turns chat.db commits into events for live clients.
//
// Detection: PRAGMA data_version is polled (it changes whenever another process
// commits); fs.watch on the Messages folder is an early trigger. In M0 a message
// was caught by the poll, not FSEvents, so the poll is the one that must work.
//
// On each change:
//   - visible rows above lastRowId          → message.new
//   - hot-window rows whose receipts/edit/
//     unsend fingerprint changed            → message.updated
//   - conversation summaries that differ    → conversation.updated (also unread counts)

import { watch, type FSWatcher } from 'node:fs';
import { dirname } from 'node:path';
import type { ConversationSummary, ServerEvent, WatcherStats } from '@imb/shared';
import type { ChatDb } from './chatdb/index.ts';

/** Rows below the newest that are re-checked for receipts, edits and unsends. */
const HOT_WINDOW_ROWS = 500;
const FS_DEBOUNCE_MS = 50;

type Trigger = keyof WatcherStats['triggers'];
type Listener = (events: ServerEvent[]) => void;

const snapshot = (conversations: ConversationSummary[]) =>
  new Map(conversations.map((c) => [c.id, JSON.stringify(c)]));

export class Watcher {
  #db: ChatDb;
  #listeners = new Set<Listener>();
  #lastRowId = 0;
  #version = -1;
  #fingerprints = new Map<number, string>();
  #conversations = new Map<string, string>();
  #interval?: NodeJS.Timeout;
  #debounce?: NodeJS.Timeout;
  #fsWatcher?: FSWatcher;

  stats: WatcherStats = {
    checks: 0,
    changes: 0,
    triggers: { fsevents: 0, poll: 0, manual: 0 },
    lastChangeAt: null,
    lastLatencyMs: null,
  };

  constructor(db: ChatDb) {
    this.#db = db;
  }

  get lastRowId(): number {
    return this.#lastRowId;
  }

  /** Takes the baseline and starts polling. pollMs 0 means only explicit check() calls. */
  start({ pollMs = 1000, watchPath }: { pollMs?: number; watchPath?: string } = {}) {
    this.#lastRowId = this.#db.lastRowId() ?? 0;
    this.#version = this.#db.dataVersion();
    this.#fingerprints = this.#db.mutableFingerprints(this.#lastRowId - HOT_WINDOW_ROWS);
    this.#conversations = snapshot(this.#db.listConversations());

    if (pollMs > 0) this.#interval = setInterval(() => this.check('poll'), pollMs);
    if (watchPath) {
      try {
        this.#fsWatcher = watch(dirname(watchPath), (_event, file) => {
          if (!file?.startsWith('chat.db')) return;
          clearTimeout(this.#debounce);
          this.#debounce = setTimeout(() => this.check('fsevents'), FS_DEBOUNCE_MS);
        });
      } catch {
        // No FSEvents access; the poll still works.
      }
    }
  }

  stop() {
    clearInterval(this.#interval);
    clearTimeout(this.#debounce);
    this.#fsWatcher?.close();
  }

  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Processes any committed changes and returns the events it emitted. */
  check(trigger: Trigger = 'manual'): ServerEvent[] {
    this.stats.checks++;
    const version = this.#db.dataVersion();
    if (version === this.#version) return [];
    this.#version = version;

    const events: ServerEvent[] = [];
    const newRowIds = new Set<number>();
    let newestSentAt = 0;

    for (let more = true; more; ) {
      const batch = this.#db.messagesAfter(this.#lastRowId);
      for (const message of batch.messages) {
        events.push({ type: 'message.new', message });
        newRowIds.add(message.rowId);
        newestSentAt = Math.max(newestSentAt, message.sentAt);
      }
      this.#lastRowId = batch.scannedTo;
      more = batch.more;
    }

    const fingerprints = this.#db.mutableFingerprints(this.#lastRowId - HOT_WINDOW_ROWS);
    const changed: number[] = [];
    for (const [rowId, fp] of fingerprints) {
      const previous = this.#fingerprints.get(rowId);
      if (previous !== undefined && previous !== fp && !newRowIds.has(rowId)) changed.push(rowId);
    }
    this.#fingerprints = fingerprints;
    for (const message of this.#db.messagesByRowIds(changed)) events.push({ type: 'message.updated', message });

    const conversations = this.#db.listConversations();
    for (const conversation of conversations) {
      if (this.#conversations.get(conversation.id) !== JSON.stringify(conversation)) {
        events.push({ type: 'conversation.updated', conversation });
      }
    }
    this.#conversations = snapshot(conversations);

    if (events.length) {
      this.stats.changes++;
      this.stats.triggers[trigger]++;
      this.stats.lastChangeAt = Date.now();
      if (newestSentAt) this.stats.lastLatencyMs = Date.now() - newestSentAt;
      for (const listener of this.#listeners) listener(events);
    }
    return events;
  }
}
