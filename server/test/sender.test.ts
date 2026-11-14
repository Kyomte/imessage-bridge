import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { SendStatus } from '@imb/shared';
import { ChatDb } from '../src/chatdb/index.ts';
import { Contacts } from '../src/contacts.ts';
import { Watcher } from '../src/watcher.ts';
import {
  Sender,
  SEND_FILE_SCRIPT,
  SEND_TEXT_SCRIPT,
  describeSendError,
  type RunOsascript,
  type SendTarget,
} from '../src/sender.ts';
import { FakeChatDb } from './fixtures/fake-chatdb.ts';

const HANDLE = '+639171234567';
let fake: FakeChatDb;
let watcher: Watcher;
let chat: ReturnType<FakeChatDb['addChat']>;
let target: SendTarget;

const wait = (ms = 0) => new Promise((r) => setTimeout(r, ms));

function makeSender(run: RunOsascript, confirmTimeoutMs = 1000) {
  const sender = new Sender(watcher, { run, confirmTimeoutMs });
  const statuses: SendStatus[] = [];
  sender.subscribe((s) => statuses.push(s));
  const last = (clientId: string) => statuses.findLast((s) => s.clientId === clientId);
  return { sender, statuses, last };
}

beforeEach(() => {
  fake = new FakeChatDb();
  chat = fake.addChat(HANDLE, { service: 'SMS' });
  watcher = new Watcher(new ChatDb(fake.path, new Contacts('/nonexistent', 'PH'), 'PH'));
  watcher.start({ pollMs: 0 });
  target = { conversationId: chat.guid, handle: HANDLE, service: 'SMS' };
});

afterEach(() => {
  watcher.stop();
  fake.close();
});

test('passes chat id, text, handle and service as argv, never in the script', async () => {
  const calls: string[][] = [];
  const { sender } = makeSender(async (script, args) => {
    assert.equal(script, SEND_TEXT_SCRIPT);
    calls.push(args);
  });
  const tricky = 'say "hi" & end tell -- \\ ¬';
  sender.send(target, tricky, 'client-0001');
  await wait();
  assert.deepEqual(calls, [[chat.guid, tricky, HANDLE, 'SMS']]);
  assert.ok(!SEND_TEXT_SCRIPT.includes(tricky));
});

test('sending becomes sent when Messages writes the matching row', async () => {
  const { sender, last } = makeSender(async () => {
    fake.addMessage(chat.chatRowId, { text: 'on my way', fromMe: true });
  });
  const queued = sender.send(target, '  on my way  ', 'client-0002');
  assert.equal(queued.state, 'queued');
  await wait();
  assert.equal(last('client-0002')?.state, 'sending');

  watcher.check();
  const status = last('client-0002')!;
  assert.equal(status.state, 'sent');
  assert.ok(status.messageId);
});

test('a row that lands in another chat guid for the same person still matches', async () => {
  const other = fake.addChat(HANDLE, { guid: `SMS;-;${HANDLE}` });
  const { sender, last } = makeSender(async () => {
    fake.addMessage(other.chatRowId, { text: 'hello', fromMe: true });
  });
  sender.send(target, 'hello', 'client-0003');
  await wait();
  watcher.check();
  assert.equal(last('client-0003')?.state, 'sent');
});

test('a fromMe message with different text does not match', async () => {
  const { sender, last } = makeSender(async () => {
    fake.addMessage(chat.chatRowId, { text: 'something else from the phone', fromMe: true });
  });
  sender.send(target, 'hello', 'client-0004');
  await wait();
  watcher.check();
  assert.equal(last('client-0004')?.state, 'sending');
});

test('no row within the timeout becomes unconfirmed', async () => {
  const { sender, last } = makeSender(async () => {}, 40);
  sender.send(target, 'into the void', 'client-0005');
  await wait(80);
  assert.equal(last('client-0005')?.state, 'unconfirmed');
});

test('an osascript failure becomes failed with a readable reason', async () => {
  const { sender, last } = makeSender(async () => {
    throw new Error('execution error: Not authorized to send Apple events to Messages. (-1743)');
  });
  sender.send(target, 'hi', 'client-0006');
  await wait();
  const status = last('client-0006')!;
  assert.equal(status.state, 'failed');
  assert.match(status.error!, /Automation/);
});

test('repeating a clientId does not send twice', async () => {
  let calls = 0;
  const { sender } = makeSender(async () => {
    calls++;
  });
  sender.send(target, 'once', 'client-0007');
  const again = sender.send(target, 'once', 'client-0007');
  await wait();
  assert.equal(calls, 1);
  assert.equal(again.clientId, 'client-0007');
});

test('sends run one at a time, in order', async () => {
  let running = 0;
  let maxRunning = 0;
  const order: string[] = [];
  const { sender } = makeSender(async (_script, args) => {
    running++;
    maxRunning = Math.max(maxRunning, running);
    order.push(args[1]);
    await wait(15);
    running--;
  });
  sender.send(target, 'one', 'client-0008');
  sender.send(target, 'two', 'client-0009');
  sender.send(target, 'three', 'client-0010');
  await wait(80);
  assert.equal(maxRunning, 1);
  assert.deepEqual(order, ['one', 'two', 'three']);
});

test('a delivery failure reported later flips sent to failed', async () => {
  let rowId = 0;
  const { sender, last } = makeSender(async () => {
    rowId = fake.addMessage(chat.chatRowId, { text: 'sms out', fromMe: true });
  });
  sender.send(target, 'sms out', 'client-0011');
  await wait();
  watcher.check();
  assert.equal(last('client-0011')?.state, 'sent');

  fake.setError(rowId);
  watcher.check();
  assert.equal(last('client-0011')?.state, 'failed');
});

test('describeSendError maps common osascript errors', () => {
  assert.match(describeSendError("Can't get chat id \"x\". (-1728)"), /could not find/);
  assert.match(describeSendError('Command failed: SIGTERM'), /did not respond/);
  assert.match(describeSendError('weird'), /could not send/);
});

test('a file send passes its path as argv, never in the script', async () => {
  const calls: { script: string; args: string[] }[] = [];
  const { sender } = makeSender(async (script, args) => {
    calls.push({ script, args });
  });
  const tricky = '/tmp/say "hi" & end tell -- ¬.png';
  sender.sendFile(target, { path: tricky, name: 'x.png' }, 'client-0012');
  await wait();
  assert.deepEqual(calls, [{ script: SEND_FILE_SCRIPT, args: [chat.guid, tricky, HANDLE, 'SMS'] }]);
  assert.ok(!SEND_FILE_SCRIPT.includes(tricky));
});

test('a file send times out on its own, longer clock', async () => {
  const sender = new Sender(watcher, { run: async () => {}, confirmTimeoutMs: 10, fileConfirmTimeoutMs: 80 });
  const seen: SendStatus[] = [];
  sender.subscribe((s) => seen.push(s));
  sender.sendFile(target, { path: '/x/y.png', name: 'y.png' }, 'client-0013');
  await wait(40);
  assert.equal(seen.findLast((s) => s.clientId === 'client-0013')?.state, 'sending');
  await wait(80);
  assert.equal(seen.findLast((s) => s.clientId === 'client-0013')?.state, 'unconfirmed');
  assert.equal(sender.status('client-0013')?.state, 'unconfirmed');
  assert.equal(sender.status('never-sent'), null);
});
