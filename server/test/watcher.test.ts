import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { ServerEvent } from '@imb/shared';
import { ChatDb } from '../src/chatdb/index.ts';
import { Contacts } from '../src/contacts.ts';
import { Watcher } from '../src/watcher.ts';
import { FakeChatDb } from './fixtures/fake-chatdb.ts';

let fake: FakeChatDb;
let watcher: Watcher;
let chat: ReturnType<FakeChatDb['addChat']>;

const ofType = <T extends ServerEvent['type']>(events: ServerEvent[], type: T) =>
  events.filter((e): e is Extract<ServerEvent, { type: T }> => e.type === type);

beforeEach(() => {
  fake = new FakeChatDb();
  chat = fake.addChat('+639171234567');
  fake.addMessage(chat.chatRowId, { text: 'older', handleRowId: chat.handleRowId, at: Date.now() - 60_000 });
  watcher = new Watcher(new ChatDb(fake.path, new Contacts('/nonexistent', 'PH'), 'PH'));
  watcher.start({ pollMs: 0 });
});

afterEach(() => {
  watcher.stop();
  fake.close();
});

test('no change, no events', () => {
  assert.deepEqual(watcher.check(), []);
});

test('a received message becomes message.new plus a conversation update', () => {
  const rowId = fake.addMessage(chat.chatRowId, { text: 'hello there', handleRowId: chat.handleRowId });
  const events = watcher.check();

  const [created] = ofType(events, 'message.new');
  assert.equal(created.message.rowId, rowId);
  assert.equal(created.message.text, 'hello there');
  assert.equal(created.message.conversationId, chat.guid);
  assert.equal(created.message.sender?.handle, '+639171234567');

  const [conversation] = ofType(events, 'conversation.updated');
  assert.equal(conversation.conversation.lastMessage.text, 'hello there');
  assert.equal(conversation.conversation.unreadCount, 2);
  assert.equal(watcher.lastRowId, rowId);
});

test('a message sent from another device (e.g. the iPhone) arrives as fromMe', () => {
  fake.addMessage(chat.chatRowId, { text: 'from my phone', fromMe: true });
  const [created] = ofType(watcher.check(), 'message.new');
  assert.equal(created.message.fromMe, true);
  assert.equal(created.message.sender, null);
});

test('delivery, read receipts and edits become message.updated', () => {
  const rowId = fake.addMessage(chat.chatRowId, { text: 'v1', fromMe: true });
  watcher.check();

  fake.markDelivered(rowId);
  let [updated] = ofType(watcher.check(), 'message.updated');
  assert.equal(updated.message.rowId, rowId);
  assert.equal(updated.message.delivered, true);

  fake.markRead(rowId);
  [updated] = ofType(watcher.check(), 'message.updated');
  assert.ok(updated.message.readAt);

  fake.edit(rowId, 'v2');
  [updated] = ofType(watcher.check(), 'message.updated');
  assert.equal(updated.message.text, 'v2');
  assert.ok(updated.message.editedAt);
});

test('tapbacks are not timeline messages', () => {
  fake.addMessage(chat.chatRowId, { tapback: true, handleRowId: chat.handleRowId });
  assert.equal(ofType(watcher.check(), 'message.new').length, 0);
});

test('a row not yet linked to a chat waits for the link instead of being skipped', () => {
  const rowId = fake.addMessage(null, { text: 'late link', handleRowId: chat.handleRowId });
  assert.equal(ofType(watcher.check(), 'message.new').length, 0);
  assert.ok(watcher.lastRowId < rowId, 'scan did not move past the unlinked row');

  fake.link(chat.chatRowId, rowId);
  const [created] = ofType(watcher.check(), 'message.new');
  assert.equal(created.message.rowId, rowId);
});

test('subscribers receive each batch', () => {
  const batches: ServerEvent[][] = [];
  const unsubscribe = watcher.subscribe((events) => batches.push(events));
  fake.addMessage(chat.chatRowId, { text: 'one', handleRowId: chat.handleRowId });
  watcher.check();
  unsubscribe();
  fake.addMessage(chat.chatRowId, { text: 'two', handleRowId: chat.handleRowId });
  watcher.check();
  assert.equal(batches.length, 1);
  assert.equal(watcher.stats.changes, 2);
});

test('large bursts are read in full', () => {
  for (let i = 0; i < 1200; i++) fake.addMessage(chat.chatRowId, { text: `m${i}`, handleRowId: chat.handleRowId });
  assert.equal(ofType(watcher.check(), 'message.new').length, 1200);
});
