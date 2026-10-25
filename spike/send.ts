// M0 send probe. Sends through Messages.app with osascript.
// The chat id, text and file path are passed as argv, never spliced into the
// script source, so message text can't inject AppleScript.
//
// Usage:
//   node spike/send.ts check                      AppleScript chat ids vs chat.db guids (counts only)
//   node spike/send.ts text <chat guid> <text>
//   node spike/send.ts file <chat guid> <path>

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';

const run = promisify(execFile);
const TIMEOUT_MS = 20_000;

const SEND_TEXT = `
on run argv
  tell application "Messages"
    send (item 2 of argv) to chat id (item 1 of argv)
  end tell
end run`;

const SEND_FILE = `
on run argv
  tell application "Messages"
    send (POSIX file (item 2 of argv)) to chat id (item 1 of argv)
  end tell
end run`;

const LIST_CHAT_IDS = `
tell application "Messages"
  set out to ""
  repeat with c in chats
    set out to out & (id of c) & linefeed
  end repeat
  return out
end tell`;

async function osascript(script: string, args: string[] = []) {
  const { stdout } = await run('osascript', ['-e', script, ...args], { timeout: TIMEOUT_MS });
  return stdout;
}

const [mode, chatId, payload] = process.argv.slice(2);

if (mode === 'check') {
  const db = new DatabaseSync(`${homedir()}/Library/Messages/chat.db`, { readOnly: true });
  const guids = new Set((db.prepare('SELECT guid FROM chat').all() as { guid: string }[]).map((r) => r.guid));
  const ids = (await osascript(LIST_CHAT_IDS)).split('\n').filter(Boolean);
  const prefixes: Record<string, number> = {};
  for (const id of ids) {
    const prefix = id.split(';').slice(0, 2).join(';');
    prefixes[prefix] = (prefixes[prefix] ?? 0) + 1;
  }
  console.log({
    appleScriptChats: ids.length,
    dbChats: guids.size,
    idsMatchingDbGuid: ids.filter((id) => guids.has(id)).length,
    prefixes,
  });
} else if (mode === 'text' && chatId && payload) {
  await osascript(SEND_TEXT, [chatId, payload]);
  console.log({ sent: 'text', at: new Date().toISOString() });
} else if (mode === 'file' && chatId && payload) {
  await osascript(SEND_FILE, [chatId, payload]);
  console.log({ sent: 'file', at: new Date().toISOString() });
} else {
  console.error('usage: node spike/send.ts check | text <chat guid> <text> | file <chat guid> <path>');
  process.exit(2);
}
