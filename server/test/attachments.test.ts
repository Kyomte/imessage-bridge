import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { SendStatus } from '@imb/shared';
import { buildApp } from '../src/app.ts';
import { ChatDb } from '../src/chatdb/index.ts';
import { DEFAULTS, type Config } from '../src/config.ts';
import { Contacts } from '../src/contacts.ts';
import type { Media } from '../src/media.ts';
import { hashPassword } from '../src/passwords.ts';
import { SEND_FILE_SCRIPT, SEND_TEXT_SCRIPT, Sender, type RunOsascript } from '../src/sender.ts';
import { Staging } from '../src/staging.ts';
import { Store } from '../src/store.ts';
import { Watcher } from '../src/watcher.ts';
import { FakeChatDb } from './fixtures/fake-chatdb.ts';

const HANDLE = '+639171234567';
const MAX_BYTES = 1024;

let fake: FakeChatDb;
let chat: ReturnType<FakeChatDb['addChat']>;
let dataDir: string;
let staging: Staging;
let watcher: Watcher;
let app: FastifyInstance;
let auth: { authorization: string };
let calls: { script: string; args: string[] }[];
let statuses: SendStatus[];
/** What the fake Messages.app does for each osascript call. */
let messages: RunOsascript;

/** Like Messages.app: a fromMe row with the file attached in place (it doesn't copy it). */
const messagesSendsFile: RunOsascript = async (_script, [, path]) => {
  const rowId = fake.addMessage(chat.chatRowId, { text: '', fromMe: true });
  fake.addAttachment(rowId, { filename: path, name: basename(path), mimeType: 'image/png' });
};

beforeEach(() => {
  fake = new FakeChatDb();
  chat = fake.addChat(HANDLE);
  // Only chats with a message are listed (and so can be sent to).
  fake.addMessage(chat.chatRowId, { text: 'hi', handleRowId: chat.handleRowId });
  dataDir = mkdtempSync(join(tmpdir(), 'imb-attach-'));
  staging = new Staging(join(dataDir, 'staging'));
  const store = new Store(dataDir);
  const contacts = new Contacts('/nonexistent', 'PH');
  const chatDb = new ChatDb(fake.path, contacts, 'PH', { seen: store });
  watcher = new Watcher(chatDb);
  watcher.start({ pollMs: 0 });
  calls = [];
  statuses = [];
  messages = messagesSendsFile;
  const sender = new Sender(watcher, {
    run: async (script, args) => {
      calls.push({ script, args });
      await messages(script, args);
    },
    fileConfirmTimeoutMs: 200,
  });
  sender.subscribe((s) => statuses.push(s));
  const media = { fillSizes: async () => {}, get: async () => null } as unknown as Media;
  const config: Config = { ...DEFAULTS, passwordHash: hashPassword('pw'), tailscaleLogin: null, defaultRegion: 'PH' };
  app = buildApp({
    config,
    chatDb,
    contacts,
    store,
    watcher,
    sender,
    media,
    staging,
    logger: false,
    maxAttachmentBytes: MAX_BYTES,
  });
  auth = { authorization: `Bearer ${store.createDevice('test').token}` };
});

afterEach(async () => {
  watcher.stop();
  await app.close();
  fake.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const wait = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/** A multipart body built the way a browser's FormData would send it. */
async function form(parts: [name: string, value: string | Blob, filename?: string][]) {
  const data = new FormData();
  for (const [name, value, filename] of parts) {
    if (typeof value === 'string') data.append(name, value);
    else data.append(name, value, filename);
  }
  const res = new Response(data);
  return { payload: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get('content-type')! };
}

async function upload(parts: Parameters<typeof form>[0], conversationId = chat.guid) {
  const { payload, contentType } = await form(parts);
  return app.inject({
    method: 'POST',
    url: `/api/conversations/${encodeURIComponent(conversationId)}/attachments`,
    headers: { ...auth, 'content-type': contentType },
    payload,
  });
}

const png = (bytes = 64) => new Blob([new Uint8Array(bytes).fill(7)], { type: 'image/png' });
const stagedFolders = () => (existsSync(staging.root) ? readdirSync(staging.root) : []);
const last = (clientId: string) => statuses.findLast((s) => s.clientId === clientId);

test('an upload is staged, sent with the file script, and confirmed by its chat.db row', async () => {
  const res = await upload([['clientId', 'client-file-01'], ['file', png(), 'IMG_0001.png']]);
  assert.equal(res.statusCode, 202);
  assert.equal((res.json() as SendStatus).clientId, 'client-file-01');
  await wait();

  assert.equal(calls.length, 1);
  const [{ script, args }] = calls;
  assert.equal(script, SEND_FILE_SCRIPT);
  const [guid, path, handle, service] = args;
  assert.deepEqual([guid, handle, service], [chat.guid, HANDLE, 'iMessage']);
  assert.equal(basename(path), 'IMG_0001.png', 'Messages shows the original name');
  assert.equal(dirname(dirname(path)), staging.root);
  assert.equal(readFileSync(path).length, 64);

  watcher.check();
  assert.equal(last('client-file-01')?.state, 'sent');
  assert.ok(existsSync(path), 'a sent file stays: its attachment row points at it');
});

test('a file whose attachment is linked after its row still matches', async () => {
  let rowId = 0;
  messages = async () => {
    rowId = fake.addMessage(chat.chatRowId, { text: '', fromMe: true });
  };
  await upload([['clientId', 'client-file-02'], ['file', png(), 'late.png']]);
  await wait();
  watcher.check();
  assert.equal(last('client-file-02')?.state, 'sending', 'no attachment yet');

  fake.addAttachment(rowId, { filename: calls[0].args[1], name: 'late.png' });
  watcher.check();
  assert.equal(last('client-file-02')?.state, 'sent');
});

test('a fromMe row with a different attachment does not match', async () => {
  messages = async () => {
    const rowId = fake.addMessage(chat.chatRowId, { text: '', fromMe: true });
    fake.addAttachment(rowId, { filename: '/elsewhere/from-the-iphone.png' });
  };
  await upload([['clientId', 'client-file-03'], ['file', png(), 'mine.png']]);
  await wait();
  watcher.check();
  assert.equal(last('client-file-03')?.state, 'sending');
  await wait(300);
  assert.equal(last('client-file-03')?.state, 'unconfirmed');
});

test('a failed osascript run deletes the staged file', async () => {
  messages = async () => {
    throw new Error("Can't get chat id (-1728)");
  };
  await upload([['clientId', 'client-file-04'], ['file', png(), 'x.png']]);
  await wait();
  assert.equal(last('client-file-04')?.state, 'failed');
  assert.deepEqual(stagedFolders(), []);
});

test('repeating a clientId does not upload or send twice', async () => {
  await upload([['clientId', 'client-file-05'], ['file', png(), 'once.png']]);
  await wait();
  const again = await upload([['clientId', 'client-file-05'], ['file', png(), 'once.png']]);
  assert.equal(again.statusCode, 202);
  await wait();
  assert.equal(calls.length, 1);
  assert.equal(stagedFolders().length, 1);
});

test('a file over the size limit is refused and nothing is left behind', async () => {
  const res = await upload([['clientId', 'client-file-06'], ['file', png(MAX_BYTES + 1), 'big.png']]);
  assert.equal(res.statusCode, 413);
  assert.deepEqual(stagedFolders(), []);
  assert.equal(calls.length, 0);
});

test('bad uploads are refused before anything is staged', async () => {
  const noId = await upload([['file', png(), 'a.png']]);
  assert.equal(noId.statusCode, 400);
  const badId = await upload([['clientId', 'x'], ['file', png(), 'a.png']]);
  assert.equal(badId.statusCode, 400);
  const noFile = await upload([['clientId', 'client-file-08']]);
  assert.equal(noFile.statusCode, 400);
  const empty = await upload([['clientId', 'client-file-09'], ['file', png(0), 'empty.png']]);
  assert.equal(empty.statusCode, 400);
  const json = await app.inject({
    method: 'POST',
    url: `/api/conversations/${encodeURIComponent(chat.guid)}/attachments`,
    headers: auth,
    payload: { clientId: 'client-file-10' },
  });
  assert.equal(json.statusCode, 400);
  const unknownChat = await upload([['clientId', 'client-file-11'], ['file', png(), 'a.png']], 'any;-;+630000000000');
  assert.equal(unknownChat.statusCode, 404);
  assert.deepEqual(stagedFolders(), []);
  assert.equal(calls.length, 0);
});

test('uploads require a device token', async () => {
  const { payload, contentType } = await form([['clientId', 'client-file-12'], ['file', png(), 'a.png']]);
  const res = await app.inject({
    method: 'POST',
    url: `/api/conversations/${encodeURIComponent(chat.guid)}/attachments`,
    headers: { 'content-type': contentType },
    payload,
  });
  assert.equal(res.statusCode, 401);
});

test('text sends still use the text script alongside files', async () => {
  messages = async (script, args) => {
    if (script === SEND_TEXT_SCRIPT) fake.addMessage(chat.chatRowId, { text: args[1], fromMe: true });
    else await messagesSendsFile(script, args);
  };
  await upload([['clientId', 'client-file-13'], ['file', png(), 'pic.png']]);
  const text = await app.inject({
    method: 'POST',
    url: `/api/conversations/${encodeURIComponent(chat.guid)}/messages`,
    headers: auth,
    payload: { text: 'caption', clientId: 'client-text-13' },
  });
  assert.equal(text.statusCode, 202);
  await wait(20);
  watcher.check();
  assert.deepEqual(
    calls.map((c) => c.script),
    [SEND_FILE_SCRIPT, SEND_TEXT_SCRIPT],
  );
  assert.equal(last('client-file-13')?.state, 'sent');
  assert.equal(last('client-text-13')?.state, 'sent');
});
