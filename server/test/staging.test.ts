import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ChatDb } from '../src/chatdb/index.ts';
import { Contacts } from '../src/contacts.ts';
import { Staging, safeName } from '../src/staging.ts';
import { FakeChatDb } from './fixtures/fake-chatdb.ts';

const dir = mkdtempSync(join(tmpdir(), 'imb-staging-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const DAY_MS = 24 * 60 * 60_000;

/** Makes a staged folder look `ageMs` old. */
function age(folder: string, ageMs: number) {
  const when = new Date(Date.now() - ageMs);
  utimesSync(folder, when, when);
}

test('safeName keeps the name people see but never a path', () => {
  assert.equal(safeName('IMG_0001.HEIC'), 'IMG_0001.HEIC');
  assert.equal(safeName('../../etc/passwd'), 'passwd');
  assert.equal(safeName('C:\\Users\\me\\report.pdf'), 'report.pdf');
  assert.equal(safeName('.hidden'), 'hidden');
  assert.equal(safeName('bad\u0000name\n.txt'), 'badname.txt');
  assert.equal(safeName('a:b.png'), 'ab.png');
  assert.equal(safeName(''), 'attachment');
  assert.equal(safeName('...'), 'attachment');
  const long = safeName(`${'é'.repeat(300)}.jpeg`);
  assert.ok(Buffer.byteLength(long) <= 200);
  assert.ok(long.endsWith('.jpeg'), 'the extension survives truncation');
});

test('create gives every file its own folder under the root', () => {
  const staging = new Staging(join(dir, 'create'));
  const a = staging.create('photo.jpg');
  const b = staging.create('photo.jpg');
  assert.notEqual(a.dir, b.dir);
  assert.equal(a.name, 'photo.jpg');
  assert.equal(dirname(a.path), a.dir);
  assert.equal(dirname(a.dir), staging.root);
  assert.ok(existsSync(a.dir));
});

test('remove only deletes staged folders', () => {
  const staging = new Staging(join(dir, 'remove'));
  const staged = staging.create('x.png');
  const outside = join(dir, 'not-staging');
  mkdirSync(outside, { recursive: true });
  staging.remove(outside);
  staging.remove(staging.root);
  staging.remove(join(staging.root, '..', 'not-staging'));
  assert.ok(existsSync(outside));
  assert.ok(existsSync(staging.root));
  staging.remove(staged.dir);
  assert.ok(!existsSync(staged.dir));
});

test('sweep deletes old folders nothing refers to, and keeps the rest', () => {
  const staging = new Staging(join(dir, 'sweep'));
  const old = staging.create('failed.png');
  const sent = staging.create('sent.png');
  const fresh = staging.create('uploading.png');
  const foreign = join(staging.root, 'keep-me');
  mkdirSync(foreign);
  for (const folder of [old.dir, sent.dir, foreign]) age(folder, 2 * DAY_MS);

  const removed = staging.sweep(new Set([sent.dir]));
  assert.equal(removed, 1);
  assert.ok(!existsSync(old.dir), 'old and unreferenced');
  assert.ok(existsSync(sent.dir), 'an attachment points at it');
  assert.ok(existsSync(fresh.dir), 'younger than a day');
  assert.ok(existsSync(foreign), 'not a staged folder');
});

test('sweep is a no-op before anything was staged', () => {
  assert.equal(new Staging(join(dir, 'never-created')).sweep(new Set()), 0);
});

test('attachmentDirsUnder finds staged files in both path forms Messages uses', () => {
  const fake = new FakeChatDb();
  try {
    const chat = fake.addChat('+639171234567');
    const root = join(homedir(), 'Library/Messages/Attachments/imessage-bridge');
    const message = fake.addMessage(chat.chatRowId, { fromMe: true });
    fake.addAttachment(message, { filename: '~/Library/Messages/Attachments/imessage-bridge/0123456789abcdef/a.png' });
    fake.addAttachment(message, { filename: join(root, 'fedcba9876543210', 'b.png') });
    fake.addAttachment(message, { filename: '~/Library/Messages/Attachments/ab/cd/elsewhere.png' });
    const chatDb = new ChatDb(fake.path, new Contacts('/nonexistent', 'PH'), 'PH');
    const dirs = chatDb.attachmentDirsUnder(root);
    assert.deepEqual([...dirs].sort(), [join(root, '0123456789abcdef'), join(root, 'fedcba9876543210')].sort());
  } finally {
    fake.close();
  }
});
