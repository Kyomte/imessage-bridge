// M0 corpus test: runs decode.ts over every attributedBody in chat.db and
// compares against the NSUnarchiver reference output (hashes only).
//
// Usage: node spike/corpus.ts <reference.tsv>
// Prints aggregate counts plus rowids/lengths of mismatches. Never prints text.

import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { decodeAttributedBody } from './decode.ts';

const referencePath = process.argv[2];
if (!referencePath) {
  console.error('usage: node spike/corpus.ts <reference.tsv>');
  process.exit(2);
}

type Ref = { status: string; hash: string; bytes: number };
const reference = new Map<number, Ref>();
for (const line of readFileSync(referencePath, 'utf8').split('\n')) {
  if (!line) continue;
  const [rowid, status, hash, bytes] = line.split('\t');
  reference.set(Number(rowid), { status, hash, bytes: Number(bytes) });
}

const db = new DatabaseSync(`${homedir()}/Library/Messages/chat.db`, { readOnly: true });
const rows = db
  .prepare('SELECT ROWID AS rowid, text, attributedBody FROM message WHERE attributedBody IS NOT NULL ORDER BY ROWID')
  .all() as { rowid: number; text: string | null; attributedBody: Uint8Array }[];

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

const counts = {
  total: rows.length,
  match: 0,
  mismatch: 0,
  decoderNull: 0,
  referenceFailed: 0,
  referenceFailedDecoderOk: 0,
  bothFailed: 0,
  textColumnAgrees: 0,
  textColumnDisagrees: 0,
};
const mismatches: string[] = [];

for (const row of rows) {
  const decoded = decodeAttributedBody(row.attributedBody);
  const ref = reference.get(row.rowid);

  if (row.text != null && decoded != null) {
    if (row.text === decoded) counts.textColumnAgrees++;
    else counts.textColumnDisagrees++;
  }

  if (!ref || ref.status !== 'ok') {
    counts.referenceFailed++;
    if (decoded != null) counts.referenceFailedDecoderOk++;
    else counts.bothFailed++;
    continue;
  }
  if (decoded == null) {
    counts.decoderNull++;
    mismatches.push(`rowid=${row.rowid} decoder=null refBytes=${ref.bytes} blobBytes=${row.attributedBody.byteLength}`);
    continue;
  }
  if (sha256(decoded) === ref.hash) {
    counts.match++;
  } else {
    counts.mismatch++;
    mismatches.push(
      `rowid=${row.rowid} decoderBytes=${Buffer.byteLength(decoded)} refBytes=${ref.bytes} blobBytes=${row.attributedBody.byteLength}`,
    );
  }
}

const comparable = counts.match + counts.mismatch + counts.decoderNull;
console.log(JSON.stringify(counts, null, 2));
console.log(`agreement: ${((100 * counts.match) / comparable).toFixed(3)}% of ${comparable} comparable rows`);
if (mismatches.length) {
  console.log(`first ${Math.min(20, mismatches.length)} of ${mismatches.length} mismatches:`);
  for (const m of mismatches.slice(0, 20)) console.log('  ' + m);
}
