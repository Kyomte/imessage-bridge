import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { CLOSE_FORBIDDEN_ORIGIN, CLOSE_UNAUTHORIZED, type ServerEvent } from '@imb/shared';
import { buildApp } from '../src/app.ts';
import { DEFAULTS, type Config } from '../src/config.ts';
import { ChatDb } from '../src/chatdb/index.ts';
import { Contacts } from '../src/contacts.ts';
import { hashPassword } from '../src/passwords.ts';
import { Store } from '../src/store.ts';
import { Watcher } from '../src/watcher.ts';
import { FakeChatDb } from './fixtures/fake-chatdb.ts';

const fake = new FakeChatDb();
const chat = fake.addChat('+639171234567');
const firstRowId = fake.addMessage(chat.chatRowId, { text: 'before connect', handleRowId: chat.handleRowId });
const dataDir = mkdtempSync(join(tmpdir(), 'imb-live-'));
const store = new Store(dataDir);
const contacts = new Contacts('/nonexistent', 'PH');
const chatDb = new ChatDb(fake.path, contacts, 'PH');
const watcher = new Watcher(chatDb);
const config: Config = { ...DEFAULTS, passwordHash: hashPassword('pw'), tailscaleLogin: null, defaultRegion: 'PH' };
const app = buildApp({ config, chatDb, contacts, store, watcher, logger: false });
const { token } = store.createDevice('test');
let url: string;

before(async () => {
  watcher.start({ pollMs: 0 });
  await app.listen({ host: '127.0.0.1', port: 0 });
  url = `ws://127.0.0.1:${(app.server.address() as AddressInfo).port}/api/ws`;
});

after(async () => {
  watcher.stop();
  await app.close();
  fake.close();
  rmSync(dataDir, { recursive: true, force: true });
});

/** Opens a socket that records events and its close code. */
function connect() {
  // Node's WebSocket can't set Origin; the origin test uses the `ws` client.
  const socket = new WebSocket(url);
  const events: ServerEvent[] = [];
  const closed = new Promise<number>((resolve) => socket.addEventListener('close', (e) => resolve(e.code)));
  const opened = new Promise<void>((resolve) => socket.addEventListener('open', () => resolve()));
  socket.addEventListener('message', (e) => events.push(JSON.parse(String(e.data))));
  const next = async (type: ServerEvent['type'], timeoutMs = 2000) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const found = events.find((e) => e.type === type);
      if (found) {
        events.splice(events.indexOf(found), 1);
        return found;
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`no ${type} event`);
  };
  return { socket, events, opened, closed, next };
}

test('a bad token is rejected with 4401', async () => {
  const c = connect();
  await c.opened;
  c.socket.send(JSON.stringify({ type: 'auth', token: 'nope' }));
  assert.equal(await c.closed, CLOSE_UNAUTHORIZED);
});

test('a non-auth first frame is rejected', async () => {
  const c = connect();
  await c.opened;
  c.socket.send(JSON.stringify({ type: 'resume', sinceRowId: 0 }));
  assert.equal(await c.closed, CLOSE_UNAUTHORIZED);
});

test('a foreign Origin is rejected', async () => {
  const { WebSocket: WsClient } = await import('ws');
  const socket = new WsClient(url, { headers: { origin: 'https://evil.example' } });
  const code = await new Promise<number>((resolve) => socket.on('close', (c) => resolve(c)));
  assert.equal(code, CLOSE_FORBIDDEN_ORIGIN);
});

test('an authed socket gets hello, live events, and resume replays', async () => {
  const c = connect();
  await c.opened;
  c.socket.send(JSON.stringify({ type: 'auth', token }));
  const hello = await c.next('hello');
  assert.equal(hello.type === 'hello' && hello.lastRowId, firstRowId);

  const rowId = fake.addMessage(chat.chatRowId, { text: 'live!', handleRowId: chat.handleRowId });
  watcher.check();
  const created = await c.next('message.new');
  assert.equal(created.type === 'message.new' && created.message.rowId, rowId);
  await c.next('conversation.updated');

  // A client that last saw firstRowId asks for what it missed.
  c.socket.send(JSON.stringify({ type: 'resume', sinceRowId: firstRowId }));
  const replayed = await c.next('message.new');
  assert.equal(replayed.type === 'message.new' && replayed.message.rowId, rowId);
  c.socket.close();
});

test('revoking a device closes its sockets', async () => {
  const other = store.createDevice('other');
  const c = connect();
  await c.opened;
  c.socket.send(JSON.stringify({ type: 'auth', token: other.token }));
  await c.next('hello');
  const res = await app.inject({
    method: 'DELETE',
    url: `/api/devices/${other.device.id}`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(await c.closed, CLOSE_UNAUTHORIZED);
});
