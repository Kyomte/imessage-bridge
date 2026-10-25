import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeAttributedBody } from '../src/chatdb/decode.ts';
import { messageText } from '../src/chatdb/index.ts';

const ascii = (s: string) => [...Buffer.from(s, 'latin1')];

function lengthBytes(n: number): number[] {
  if (n < 0x80) return [n];
  if (n < 0x8000) return [0x81, n & 0xff, n >> 8];
  return [0x82, n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, n >>> 24];
}

/** Minimal typedstream NSAttributedString, shaped like real attributedBody blobs. */
function blob(text: string, stringClass = 'NSString'): Uint8Array {
  const utf8 = [...Buffer.from(text, 'utf8')];
  return Uint8Array.from([
    0x04, 0x0b, ...ascii('streamtyped'), 0x81, 0xe8, 0x03,
    0x84, 0x01, 0x40,
    0x84, 0x84, 0x84, 0x12, ...ascii('NSAttributedString'), 0x00,
    0x84, 0x84, 0x08, ...ascii('NSObject'), 0x00, 0x85,
    0x92, 0x84, 0x84, 0x84, stringClass.length, ...ascii(stringClass), 0x01, 0x94,
    0x84, 0x01, 0x2b, ...lengthBytes(utf8.length), ...utf8,
    0x86,
  ]);
}

test('decodes short strings', () => {
  assert.equal(decodeAttributedBody(blob('hello')), 'hello');
});

test('decodes multi-byte UTF-8 (emoji, accents)', () => {
  assert.equal(decodeAttributedBody(blob('salamat po 🙏 café')), 'salamat po 🙏 café');
});

test('decodes int16-length strings', () => {
  const long = 'x'.repeat(1000);
  assert.equal(decodeAttributedBody(blob(long)), long);
});

test('decodes int32-length strings', () => {
  const huge = 'y'.repeat(40_000);
  assert.equal(decodeAttributedBody(blob(huge)), huge);
});

test('decodes NSMutableString bodies', () => {
  assert.equal(decodeAttributedBody(blob('mutable', 'NSMutableString')), 'mutable');
});

test('returns null for blobs without a string class', () => {
  assert.equal(decodeAttributedBody(Uint8Array.from([0x04, 0x0b, 0x00])), null);
});

test('returns null for truncated blobs', () => {
  const full = blob('hello world');
  assert.equal(decodeAttributedBody(full.subarray(0, full.length - 6)), null);
});

test('messageText strips attachment placeholders and prefers attributedBody', () => {
  assert.equal(messageText('stale', blob('￼nice pic')), 'nice pic');
  assert.equal(messageText('plain', null), 'plain');
  assert.equal(messageText(null, null), '');
});
