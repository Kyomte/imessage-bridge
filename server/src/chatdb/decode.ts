// Extracts the plain text from a message.attributedBody blob.
//
// The blob is an NSAttributedString serialized with NSArchiver ("typedstream").
// We only need the backing NSString / NSMutableString, which is written as the
// first '+'-typed value (length-prefixed UTF-8 bytes) after its class definition:
//
//   ... 84 84 84 08 "NSString" 01 94 84 01 2b <len> <utf8 bytes> 86 ...
//        new  new  str len      ver  super new "+"
//
// Integers in typedstream are a single signed byte unless prefixed by a tag:
// 0x81 => int16 LE follows, 0x82 => int32 LE follows.

const TAG_INT16 = 0x81;
const TAG_INT32 = 0x82;
const TAG_NEW = 0x84;
const PLUS = 0x2b;

const STRING_CLASS_MARKERS = ['NSString', 'NSMutableString'].map((name) =>
  Buffer.concat([Buffer.from([name.length]), Buffer.from(name, 'latin1')]),
);

const utf8 = new TextDecoder('utf-8');

export function decodeAttributedBody(blob: Uint8Array): string | null {
  const buf = Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength);

  let classEnd = -1;
  for (const marker of STRING_CLASS_MARKERS) {
    const at = buf.indexOf(marker);
    if (at >= 0 && (classEnd < 0 || at < classEnd)) classEnd = at + marker.length;
  }
  if (classEnd < 0) return null;

  for (let i = classEnd; i < buf.length - 3; i++) {
    if (buf[i] === TAG_NEW && buf[i + 1] === 0x01 && buf[i + 2] === PLUS) {
      return readLengthPrefixed(buf, i + 3);
    }
  }
  return null;
}

function readLengthPrefixed(buf: Buffer, pos: number): string | null {
  let len: number;
  const tag = buf[pos];
  if (tag === TAG_INT16) {
    len = buf.readUInt16LE(pos + 1);
    pos += 3;
  } else if (tag === TAG_INT32) {
    len = buf.readUInt32LE(pos + 1);
    pos += 5;
  } else {
    len = tag;
    pos += 1;
  }
  if (pos + len > buf.length) return null;
  return utf8.decode(buf.subarray(pos, pos + len));
}
