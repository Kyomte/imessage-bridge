// M0 watcher probe: detects new chat.db rows and logs metadata only (never text).
//
// Two triggers, whichever fires first wins:
//   - fsevents: fs.watch on ~/Library/Messages for chat.db / chat.db-wal writes
//   - poll:     PRAGMA data_version once a second (changes when another process commits)
//
// latencyMs = detection time - message.date, so for messages sent from the iPhone
// it includes the iCloud sync delay, which is what the app will actually feel.
//
// Usage: node spike/watch.ts [minutes]   (default 30)

import { DatabaseSync } from 'node:sqlite';
import { watch } from 'node:fs';
import { homedir } from 'node:os';

const APPLE_EPOCH_MS = 978_307_200_000;
const dir = `${homedir()}/Library/Messages`;
const minutes = Number(process.argv[2] ?? 30);

const db = new DatabaseSync(`${dir}/chat.db`, { readOnly: true });
const dataVersion = db.prepare('PRAGMA data_version');
// Apple dates (~8e17 ns) exceed Number.MAX_SAFE_INTEGER and node:sqlite throws on
// them, so convert to Unix ms inside SQL.
const newRows = db.prepare(`
  SELECT m.ROWID AS rowid, m.is_from_me AS fromMe,
         m.date / 1000000 + ${APPLE_EPOCH_MS} AS sentAtMs, m.service,
         m.associated_message_type AS assocType, m.cache_has_attachments AS hasAttachments,
         m.error, c.style
  FROM message m
  LEFT JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
  LEFT JOIN chat c ON c.ROWID = cmj.chat_id
  WHERE m.ROWID > ?
  ORDER BY m.ROWID`);

let lastRowId = (db.prepare('SELECT MAX(ROWID) AS m FROM message').get() as { m: number }).m;
let lastVersion = (dataVersion.get() as { data_version: number }).data_version;
let fsEvents = 0;
let debounce: NodeJS.Timeout | undefined;

const log = (event: Record<string, unknown>) =>
  console.log(JSON.stringify({ at: new Date().toISOString(), ...event }));

function check(source: string) {
  const rows = newRows.all(lastRowId) as Record<string, number | string | null>[];
  for (const row of rows) {
    const sentAtMs = Number(row.sentAtMs);
    log({
      source,
      rowid: row.rowid,
      fromMe: row.fromMe === 1,
      service: row.service,
      tapback: Number(row.assocType) !== 0,
      hasAttachments: row.hasAttachments === 1,
      group: row.style === 43,
      error: row.error,
      latencyMs: Math.round(Date.now() - sentAtMs),
    });
    lastRowId = Math.max(lastRowId, Number(row.rowid));
  }
}

watch(dir, (_event, file) => {
  if (!file?.startsWith('chat.db')) return;
  fsEvents++;
  clearTimeout(debounce);
  debounce = setTimeout(() => check('fsevents'), 75);
});

setInterval(() => {
  const version = (dataVersion.get() as { data_version: number }).data_version;
  if (version !== lastVersion) {
    lastVersion = version;
    check('poll');
  }
}, 1000);

log({ started: true, lastRowId, minutes });
setTimeout(() => {
  log({ stopped: true, fsEvents, lastRowId });
  process.exit(0);
}, minutes * 60_000);
