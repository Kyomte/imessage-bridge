import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { ConversationSummary, ServerEvent } from '@imb/shared';
import { buildApp } from '../src/app.ts';
import { ChatDb } from '../src/chatdb/index.ts';
import { DEFAULTS, type Config } from '../src/config.ts';
import { Contacts } from '../src/contacts.ts';
import type { Media } from '../src/media.ts';
import { hashPassword } from '../src/passwords.ts';
import { Sender } from '../src/sender.ts';
import { Staging } from '../src/staging.ts';
import { Store } from '../src/store.ts';
import { Watcher } from '../src/watcher.ts';
import { FakeChatDb } from './fixtures/fake-chatdb.ts';

const fake = new FakeChatDb();
const chat = fake.addChat('+639171234567');
const other = fake.addChat('+639170000000');
const dataDir = mkdtempSync(join(tmpdir(), 'imb-seen-'));
const store = new Store(dataDir);
const contacts = new Contacts('/nonexistent', 'PH');
const chatDb = new ChatDb(fake.path, contacts, 'PH', { seen: store });
const watcher = new Watcher(chatDb);
const sender = new Sender(watcher, { run: async () => {} });
const media = { fillSizes: async () => {}, get: async () => null } as unknown as Media;
const staging = new Staging(join(dataDir, 'staging'));
const config: Config = { ...DEFAULTS, passwordHash: hashPassword('pw'), tailscaleLogin: null, defaultRegion: 'PH' };
const app = buildApp({ config, chatDb, contacts, store, watcher, sender, media, staging, logger: false });
const { token } = store.createDevice('test');
const auth = { authorization: `Bearer ${token}` };
let wsUrl: string;

before(async () => {
  watcher.start({ pollMs: 0 });
  await app.listen({ host: '127.0.0.1', port: 0 });
  wsUrl = `ws://127.0.0.1:${(app.server.address() as AddressInfo).port}/api/ws`;
});

after(async () => {
  watcher.stop();
  await app.close();
  fake.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const incoming = (c: { chatRowId: number; handleRowId: number }, text: string) =>
  fake.addMessage(c.chatRowId, { text, handleRowId: c.handleRowId });
const unread = (id: string) => chatDb.getConversation(id)!.unreadCount;
const markRead = (id: string, payload: unknown) =>
  app.inject({ method: 'POST', url: `/api/conversations/${encodeURIComponent(id)}/read`, headers: auth, payload: payload as object });

test('the seen marker only moves forward', () => {
  assert.equal(store.markSeen('chat-x', 10), true);
  const version = store.seenVersion;
  assert.equal(store.markSeen('chat-x', 5), false);
  assert.equal(store.markSeen('chat-x', 10), false);
  assert.equal(store.seenVersion, version, 'no move, no new version');
  assert.equal(store.markSeen('chat-x', 11), true);
  assert.equal(JSON.parse(store.seenJson())['chat-x'], 11);
});

test('unread counts only messages after the seen marker', () => {
  const first = incoming(chat, 'one');
  const second = incoming(chat, 'two');
  assert.equal(unread(chat.guid), 2);

  // Only the bridge's own database changes here, so the cache must notice the marker.
  store.markSeen(chat.guid, first);
  assert.equal(unread(chat.guid), 1);
  store.markSeen(chat.guid, second);
  assert.equal(unread(chat.guid), 0);

  const third = incoming(chat, 'three');
  assert.equal(unread(chat.guid), 1, 'a newer message is unread again');
  fake.markRead(third);
  assert.equal(unread(chat.guid), 0, 'read on the Mac or iPhone still counts as read');
});

test('POST /read checks the conversation and the rowId', async () => {
  const rowId = incoming(other, 'hello');
  assert.equal((await markRead('any;-;+630000000000', { upToRowId: rowId })).statusCode, 404);
  for (const bad of [{}, { upToRowId: 0 }, { upToRowId: 1.5 }, { upToRowId: String(rowId) }, { upToRowId: rowId + 1000 }]) {
    assert.equal((await markRead(other.guid, bad)).statusCode, 400, JSON.stringify(bad));
  }
  assert.equal(unread(other.guid), 1, 'nothing was marked');
});

test('POST /read clears the count and tells every device', async () => {
  const socket = new WebSocket(wsUrl);
  const events: ServerEvent[] = [];
  socket.addEventListener('message', (e) => events.push(JSON.parse(String(e.data))));
  await new Promise((resolve) => socket.addEventListener('open', resolve));
  socket.send(JSON.stringify({ type: 'auth', token }));
  const waitFor = async (match: (e: ServerEvent) => boolean) => {
    for (let i = 0; i < 200; i++) {
      const found = events.find(match);
      if (found) return found;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('event not received');
  };
  await waitFor((e) => e.type === 'hello');

  const rowId = incoming(other, 'are you there?');
  watcher.check();
  assert.ok(unread(other.guid) > 0);

  const res = await markRead(other.guid, { upToRowId: rowId });
  assert.equal(res.statusCode, 200);
  assert.equal((res.json() as ConversationSummary).unreadCount, 0);
  const update = await waitFor(
    (e) => e.type === 'conversation.updated' && e.conversation.id === other.guid && e.conversation.unreadCount === 0,
  );
  assert.ok(update);

  const list = await app.inject({ url: '/api/conversations', headers: auth });
  assert.equal((list.json() as ConversationSummary[]).find((c) => c.id === other.guid)?.unreadCount, 0);

  // Marking the same row again is harmless and doesn't broadcast.
  const before = events.length;
  assert.equal((await markRead(other.guid, { upToRowId: rowId })).statusCode, 200);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(events.length, before);
  socket.close();
});

test('POST /read requires a device token', async () => {
  const res = await app.inject({
    method: 'POST',
    url: `/api/conversations/${encodeURIComponent(chat.guid)}/read`,
    payload: { upToRowId: 1 },
  });
  assert.equal(res.statusCode, 401);
});
