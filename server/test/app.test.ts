import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/app.ts';
import { Staging } from '../src/staging.ts';
import { DEFAULTS, type Config } from '../src/config.ts';
import { hashPassword } from '../src/passwords.ts';
import { Store } from '../src/store.ts';
import type { ChatDb } from '../src/chatdb/index.ts';
import type { Contacts } from '../src/contacts.ts';
import type { Watcher } from '../src/watcher.ts';
import type { Sender } from '../src/sender.ts';

const dir = mkdtempSync(join(tmpdir(), 'imb-app-'));
after(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

const config: Config = {
  ...DEFAULTS,
  passwordHash: hashPassword('right-password'),
  tailscaleLogin: 'me@example.com',
  defaultRegion: 'PH',
};
const chatDb = {
  listConversations: () => [],
  getConversation: () => null,
  lastRowId: () => 1,
} as unknown as ChatDb;
const contacts = { count: 0 } as unknown as Contacts;
const watcher = { subscribe: () => () => {}, lastRowId: 0 } as unknown as Watcher;
const sender = { subscribe: () => () => {} } as unknown as Sender;
const media = { fillSizes: async () => {}, get: async () => null } as unknown as import('../src/media.ts').Media;
const staging = new Staging(join(dir, 'staging'));
const app = buildApp({ config, chatDb, contacts, store: new Store(dir), watcher, sender, media, staging, logger: false });

test('ping is public', async () => {
  const res = await app.inject({ url: '/api/ping' });
  assert.equal(res.statusCode, 200);
});

test('API routes require a device token', async () => {
  assert.equal((await app.inject({ url: '/api/conversations' })).statusCode, 401);
  const bad = await app.inject({ url: '/api/conversations', headers: { authorization: 'Bearer nope' } });
  assert.equal(bad.statusCode, 401);
});

test('pairing rejects a wrong password', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/auth/pair', payload: { password: 'wrong' } });
  assert.equal(res.statusCode, 401);
});

test('pairing issues a token that unlocks the API', async () => {
  const pair = await app.inject({
    method: 'POST',
    url: '/api/auth/pair',
    payload: { password: 'right-password', deviceName: 'test' },
  });
  assert.equal(pair.statusCode, 200);
  const { token } = pair.json();
  const res = await app.inject({ url: '/api/conversations', headers: { authorization: `Bearer ${token}` } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), []);

  const missing = await app.inject({
    url: '/api/conversations/nope/messages',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(missing.statusCode, 404);
});

test('a different tailnet login is rejected even with a valid token', async () => {
  const pair = await app.inject({ method: 'POST', url: '/api/auth/pair', payload: { password: 'right-password' } });
  const res = await app.inject({
    url: '/api/conversations',
    headers: { authorization: `Bearer ${pair.json().token}`, 'tailscale-user-login': 'someone-else@example.com' },
  });
  assert.equal(res.statusCode, 403);
});

test('pairing is rate limited after repeated failures', async () => {
  const statuses: number[] = [];
  for (let i = 0; i < 6; i++) {
    const res = await app.inject({ method: 'POST', url: '/api/auth/pair', payload: { password: `wrong-${i}` } });
    statuses.push(res.statusCode);
  }
  assert.equal(statuses.at(-1), 429);
});

test('servedBundle reads the hashed bundle name from index.html', async () => {
  const { servedBundle } = await import('../src/app.ts');
  const { writeFileSync, mkdirSync } = await import('node:fs');
  const clientDir = join(dir, 'dist');
  mkdirSync(clientDir, { recursive: true });
  assert.equal(servedBundle(clientDir), null);
  writeFileSync(join(clientDir, 'index.html'), '<script type="module" src="/assets/index-AbC_12-x.js"></script>');
  assert.equal(servedBundle(clientDir), 'index-AbC_12-x.js');
});
