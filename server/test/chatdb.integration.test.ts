// Runs against the real ~/Library/Messages/chat.db (skipped without access).
// Asserts structure and ordering only; never prints message content.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accessSync, constants } from 'node:fs';
import { ChatDb } from '../src/chatdb/index.ts';
import { Contacts } from '../src/contacts.ts';
import { DEFAULTS } from '../src/config.ts';

let readable = true;
try {
  accessSync(DEFAULTS.chatDbPath, constants.R_OK);
} catch {
  readable = false;
}

const skip = readable ? false : 'chat.db not readable (needs Full Disk Access)';
const db = readable ? new ChatDb(DEFAULTS.chatDbPath, new Contacts(DEFAULTS.addressBookDir, 'PH'), 'PH') : null!;

test('conversations are listed newest first with sane fields', { skip }, () => {
  const conversations = db.listConversations();
  assert.ok(conversations.length > 0);
  for (let i = 1; i < conversations.length; i++) {
    assert.ok(conversations[i - 1].lastMessage.at >= conversations[i].lastMessage.at, 'sorted by last message');
  }
  const minDate = Date.UTC(2009, 0, 1);
  const maxDate = Date.now() + 86_400_000;
  for (const c of conversations) {
    assert.ok(c.id && c.title, 'id and title present');
    assert.ok(c.lastMessage.at > minDate && c.lastMessage.at < maxDate, 'last message date in range');
    assert.ok(c.unreadCount >= 0);
    assert.ok(c.participants.length > 0, 'has participants');
  }
});

test('conversation list is cached until chat.db changes', { skip }, () => {
  assert.equal(db.listConversations(), db.listConversations());
});

test('message pages walk back through history without gaps or repeats', { skip }, () => {
  const busiest = db.listConversations().slice(0, 5);
  for (const conversation of busiest) {
    const seen = new Set<string>();
    let cursor: string | undefined;
    let previousOldest = Infinity;
    for (let page = 0; page < 4; page++) {
      const result = db.listMessages(conversation.id, { before: cursor, limit: 25 });
      const times = result.messages.map((m) => m.sentAt);
      for (let i = 1; i < times.length; i++) assert.ok(times[i - 1] <= times[i], 'oldest first within a page');
      if (times.length) {
        assert.ok(times.at(-1)! <= previousOldest, 'pages move back in time');
        previousOldest = times[0];
      }
      for (const m of result.messages) {
        assert.ok(!seen.has(m.id), 'no message repeated across pages');
        seen.add(m.id);
        assert.equal(m.conversationId, conversation.id);
        if (m.fromMe) assert.equal(m.sender, null, 'sent messages have no sender');
        else assert.ok(m.sender, 'received messages have a sender');
      }
      if (!result.nextCursor) break;
      cursor = result.nextCursor;
    }
  }
});

test('bad cursors are rejected', { skip }, () => {
  const [first] = db.listConversations();
  assert.throws(() => db.listMessages(first.id, { before: 'drop table' }), /bad cursor/);
});
