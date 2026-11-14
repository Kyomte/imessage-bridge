import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatDb } from '../src/chatdb/index.ts';
import { Contacts } from '../src/contacts.ts';
import { Media, pickStreams } from '../src/media.ts';
import { Store } from '../src/store.ts';
import { buildApp } from '../src/app.ts';
import { Staging } from '../src/staging.ts';
import { DEFAULTS } from '../src/config.ts';
import { hashPassword } from '../src/passwords.ts';
import { Watcher } from '../src/watcher.ts';
import { Sender } from '../src/sender.ts';
import { FakeChatDb } from './fixtures/fake-chatdb.ts';
import { haveMediaTools, makeMediaFiles, probe, sipsProps, type MediaFiles } from './fixtures/media-files.ts';

const skip = haveMediaTools() ? false : 'needs ffmpeg and sips';
const dir = mkdtempSync(join(tmpdir(), 'imb-media-'));
const attachmentsRoot = join(dir, 'Attachments');
const fake = new FakeChatDb();
const chat = fake.addChat('+639175555555');
const store = new Store(join(dir, 'data'));
const contacts = new Contacts('/nonexistent', 'PH');
const chatDb = new ChatDb(fake.path, contacts, 'PH');
let files: MediaFiles;
let media: Media;
const ids: Record<string, string> = {};

function attach(key: string, filename: string | null, opts: { mimeType?: string | null; sticker?: boolean; transferState?: number } = {}) {
  const rowId = fake.addMessage(chat.chatRowId, { text: '', handleRowId: chat.handleRowId });
  ids[key] = fake.addAttachment(rowId, { filename, ...opts });
}

before(() => {
  if (skip) return;
  files = makeMediaFiles(attachmentsRoot);
  attach('jpeg', files.jpeg, { mimeType: 'image/jpeg' });
  attach('heic', files.heic, { mimeType: 'image/heic' });
  attach('sticker', files.sticker, { mimeType: 'image/png', sticker: true });
  attach('hevc', files.hevc, { mimeType: 'video/quicktime' });
  attach('h264', files.h264, { mimeType: 'video/quicktime' });
  attach('caf', files.caf, { mimeType: null });
  attach('pdf', files.pdf, { mimeType: 'application/pdf' });
  attach('odd', files.oddName, { mimeType: 'application/octet-stream' });
  attach('outside', '/etc/hosts', { mimeType: 'text/plain' });
  symlinkSync('/etc/hosts', join(attachmentsRoot, 'ab', 'sneaky.txt'));
  attach('symlink', join(attachmentsRoot, 'ab', 'sneaky.txt'), { mimeType: 'text/plain' });
  attach('downloading', files.jpeg, { mimeType: 'image/jpeg', transferState: 3 });
  attach('missing', join(attachmentsRoot, 'nope.jpg'), { mimeType: 'image/jpeg' });
  media = new Media(chatDb, store, { cacheDir: join(dir, 'cache'), attachmentsRoot });
});

after(() => {
  fake.close();
  rmSync(dir, { recursive: true, force: true });
});

test('photo: ≤400 px JPEG thumb with its size recorded; JPEG preview is the original', { skip }, async () => {
  const thumb = await media.get(ids.jpeg, 'thumb');
  const props = sipsProps(thumb!.path);
  assert.equal(props.format, 'jpeg');
  assert.equal(props.pixelWidth, '400');
  assert.deepEqual(store.mediaSize(ids.jpeg), { width: 400, height: 266 });
  assert.equal((await media.get(ids.jpeg, 'preview'))!.path.endsWith('photo.jpg'), true);
});

test('HEIC: converted to JPEG for both thumb and preview', { skip }, async () => {
  const preview = await media.get(ids.heic, 'preview');
  assert.equal(sipsProps(preview!.path).format, 'jpeg');
  assert.equal(sipsProps((await media.get(ids.heic, 'thumb'))!.path).format, 'jpeg');
});

test('sticker: PNG thumb keeps transparency and is never enlarged', { skip }, async () => {
  const props = sipsProps((await media.get(ids.sticker, 'thumb'))!.path);
  assert.equal(props.format, 'png');
  assert.equal(props.hasAlpha, 'yes');
  assert.equal(props.pixelWidth, '300'); // source is 300 px; sips -Z alone would make it 400
});

test('HEIC preview smaller than 2048 px keeps its size', { skip }, async () => {
  assert.equal(sipsProps((await media.get(ids.heic, 'preview'))!.path).pixelWidth, '1200');
});

test('HEVC video: transcoded to H.264 MP4, poster frame thumb', { skip }, async () => {
  const preview = await media.get(ids.hevc, 'preview');
  assert.equal(probe(preview!.path, 'format=format_name').includes('mp4'), true);
  assert.equal(probe(preview!.path, 'stream=codec_name').split('\n')[0], 'h264');
  assert.equal(sipsProps((await media.get(ids.hevc, 'thumb'))!.path).format, 'jpeg');
  assert.ok(store.mediaSize(ids.hevc));
});

test('H.264 video: rewrapped as MP4 without re-encoding', { skip }, async () => {
  const preview = await media.get(ids.h264, 'preview');
  assert.equal(probe(preview!.path, 'stream=codec_name'), 'h264');
});

test('CAF voice message: converted to AAC m4a', { skip }, async () => {
  const preview = await media.get(ids.caf, 'preview');
  assert.ok(preview!.path.endsWith('.m4a'));
  assert.equal(probe(preview!.path, 'stream=codec_name'), 'aac');
});

test('pickStreams skips audio tracks ffmpeg cannot decode', () => {
  const picked = pickStreams([
    { index: 0, codec_type: 'video', codec_name: 'h264' },
    { index: 1, codec_type: 'audio', codec_name: 'none' },
    { index: 2, codec_type: 'audio', codec_name: 'aac' },
    { index: 3, codec_type: 'data' },
  ]);
  assert.equal(picked.video?.index, 0);
  assert.equal(picked.audio?.index, 2);
  assert.equal(pickStreams([{ index: 0, codec_type: 'video', codec_name: 'hevc' }, { index: 1, codec_type: 'audio', codec_name: 'none' }]).audio, null);
  assert.equal(pickStreams([{ index: 0, codec_type: 'audio', codec_name: 'aac' }]).video, null);
});

test('files: no thumb, preview is the original', { skip }, async () => {
  assert.equal(await media.get(ids.pdf, 'thumb'), null);
  assert.ok((await media.get(ids.pdf, 'preview'))!.path.endsWith('doc.pdf'));
});

test('files outside the Attachments folder are never served', { skip }, async () => {
  assert.equal(await media.get(ids.outside, 'original'), null);
  assert.equal(await media.get(ids.symlink, 'original'), null);
});

test('missing files and downloads in progress are not served', { skip }, async () => {
  assert.equal(await media.get(ids.missing, 'original'), null);
  assert.equal(await media.get(ids.downloading, 'original'), null);
  assert.equal(await media.get('no-such-id', 'original'), null);
});

test('identical requests share one conversion', { skip }, async () => {
  const fresh = new Media(chatDb, store, { cacheDir: join(dir, 'cache-dedupe'), attachmentsRoot });
  const [a, b] = await Promise.all([fresh.get(ids.heic, 'preview'), fresh.get(ids.heic, 'preview')]);
  assert.equal(a!.path, b!.path);
  assert.deepEqual(readdirSync(join(dir, 'cache-dedupe')), [a!.path.split('/').at(-1)]);
});

test('fillSizes adds thumbnail sizes to a message page', { skip }, async () => {
  const page = chatDb.listMessages(chat.guid, { limit: 200 });
  await media.fillSizes(page.messages, 10_000);
  const jpeg = page.messages.flatMap((m) => m.attachments).find((a) => a.id === ids.jpeg)!;
  assert.deepEqual([jpeg.width, jpeg.height], [400, 266]);
  const pdf = page.messages.flatMap((m) => m.attachments).find((a) => a.id === ids.pdf)!;
  assert.equal(pdf.width, null);
});

test('the cache evicts least recently used files when over its cap', { skip }, async () => {
  const cacheDir = join(dir, 'cache-small');
  const small = new Media(chatDb, store, { cacheDir, attachmentsRoot, maxCacheBytes: 1 });
  await small.get(ids.jpeg, 'thumb');
  await small.get(ids.heic, 'thumb');
  assert.ok(readdirSync(cacheDir).length <= 1);
});

test('attachment route: media tokens, downloads and ranges', { skip }, async () => {
  const watcher = new Watcher(chatDb);
  const sender = new Sender(watcher, { run: async () => {} });
  const config = { ...DEFAULTS, passwordHash: hashPassword('x'), tailscaleLogin: null, defaultRegion: 'PH' };
  const staging = new Staging(join(dir, 'staging'));
  const app = buildApp({ config, chatDb, contacts, store, watcher, sender, media, staging, logger: false });
  const { token, device } = store.createDevice('media-test');
  try {
    const get = (url: string, headers: Record<string, string> = {}) => app.inject({ url, headers });
    const tokenRes = await get('/api/media-token', { authorization: `Bearer ${token}` });
    const { token: t } = tokenRes.json();

    const thumb = await get(`/api/attachments/${ids.jpeg}/thumb?t=${encodeURIComponent(t)}`);
    assert.equal(thumb.statusCode, 200);
    assert.equal(thumb.headers['content-type'], 'image/jpeg');

    assert.equal((await get(`/api/attachments/${ids.jpeg}/thumb`)).statusCode, 401);
    assert.equal((await get(`/api/attachments/${ids.jpeg}/thumb?t=${device.id}.9999999999999.forged`)).statusCode, 401);
    assert.equal((await get(`/api/attachments/${ids.jpeg}/bogus?t=${t}`)).statusCode, 404);
    assert.equal((await get(`/api/attachments/${ids.outside}/original?t=${t}`)).statusCode, 404);
    // A media token only opens attachments, nothing else.
    assert.equal((await get(`/api/conversations?t=${t}`)).statusCode, 401);

    const download = await get(`/api/attachments/${ids.odd}/original?download=1&t=${t}`);
    assert.equal(download.statusCode, 200);
    assert.match(String(download.headers['content-disposition']), /filename\*=UTF-8''my%20photo%20%231%20%C3%A9\.jpg/);

    const range = await get(`/api/attachments/${ids.odd}/original?t=${t}`, { range: 'bytes=0-99' });
    assert.equal(range.statusCode, 206);
    assert.equal(range.rawPayload.length, 100);

    store.revokeDevice(device.id);
    assert.equal((await get(`/api/attachments/${ids.jpeg}/thumb?t=${t}`)).statusCode, 401);
  } finally {
    await app.close();
  }
});

test('a finished download shows up as a message update', { skip }, () => {
  const watcher = new Watcher(chatDb);
  const rowId = fake.addMessage(chat.chatRowId, { text: '', handleRowId: chat.handleRowId });
  const guid = fake.addAttachment(rowId, { filename: files.jpeg, mimeType: 'image/jpeg', transferState: 3 });
  watcher.start({ pollMs: 0 });
  fake.setTransferState(guid, 5);
  const updated = watcher.check().find((e) => e.type === 'message.updated');
  assert.ok(updated && updated.type === 'message.updated' && updated.message.attachments[0].available);
  watcher.stop();
  writeFileSync(join(dir, 'done'), '');
});
