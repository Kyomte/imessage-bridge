import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatHandle, normalizeHandle } from '../src/contacts.ts';
import { attachmentKind } from '../src/chatdb/index.ts';
import { generatePassword, hashPassword, verifyPassword } from '../src/passwords.ts';
import { Store } from '../src/store.ts';

test('normalizeHandle maps local and international PH formats to E.164', () => {
  assert.equal(normalizeHandle('+63 917 123 4567', 'PH'), '+639171234567');
  assert.equal(normalizeHandle('0917-123-4567', 'PH'), '+639171234567');
  assert.equal(normalizeHandle('(0917) 123 4567', 'PH'), '+639171234567');
});

test('normalizeHandle keeps emails and short codes comparable', () => {
  assert.equal(normalizeHandle(' Someone@Example.COM ', 'PH'), 'someone@example.com');
  assert.equal(normalizeHandle('2346', 'PH'), '2346');
  assert.equal(normalizeHandle('GCash', 'PH'), 'gcash');
});

test('formatHandle pretty-prints valid numbers only', () => {
  assert.equal(formatHandle('+639171234567', 'PH'), '+63 917 123 4567');
  assert.equal(formatHandle('2346', 'PH'), '2346');
  assert.equal(formatHandle('a@b.co', 'PH'), 'a@b.co');
});

test('attachmentKind uses mime type, then extension', () => {
  assert.equal(attachmentKind('image/heic', 'IMG_1.HEIC'), 'image');
  assert.equal(attachmentKind('video/quicktime', 'clip.mov'), 'video');
  assert.equal(attachmentKind(null, 'Audio Message.caf'), 'audio');
  assert.equal(attachmentKind(null, 'IMG_2.HEIC'), 'image');
  assert.equal(attachmentKind('application/pdf', 'doc.pdf'), 'file');
});

test('password hash round-trips and rejects wrong passwords', () => {
  const password = generatePassword();
  assert.match(password, /^[a-z2-9]{4}(-[a-z2-9]{4}){3}$/);
  const hash = hashPassword(password);
  assert.ok(verifyPassword(password, hash));
  assert.ok(!verifyPassword(password + 'x', hash));
  assert.ok(!verifyPassword(password, 'garbage'));
});

test('store issues, resolves and revokes device tokens', () => {
  const dir = mkdtempSync(join(tmpdir(), 'imb-store-'));
  try {
    const store = new Store(dir);
    const { device, token } = store.createDevice('laptop');
    assert.equal(store.deviceForToken(token)?.id, device.id);
    assert.equal(store.deviceForToken(token + 'x'), null);
    assert.ok(store.revokeDevice(device.id));
    assert.equal(store.deviceForToken(token), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
