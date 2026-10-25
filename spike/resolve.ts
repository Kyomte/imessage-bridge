// M3 probe (read-only, sends nothing): can AppleScript address chats that are not in
// Messages' `chats` list, either by chat id or by participant on the right account?
// Prints booleans only, never handles or chat ids.
//
// Usage: node spike/resolve.ts

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';

const run = promisify(execFile);
const osascript = async (script: string, args: string[] = []) =>
  (await run('osascript', ['-e', script, ...args], { timeout: 20_000 })).stdout.trim();

const LIST_IDS = `tell application "Messages" to get id of chats`;

const PROBE = `
on run argv
  set chatGuid to item 1 of argv
  set handleId to item 2 of argv
  set svc to item 3 of argv
  tell application "Messages"
    set chatExists to exists chat id chatGuid
    try
      if svc is "SMS" then
        set acct to first account whose service type is SMS
      else
        set acct to first account whose service type is iMessage
      end if
      set accountFound to true
    on error
      set accountFound to false
    end try
    set participantFound to false
    if accountFound then
      try
        get handle of participant handleId of acct
        set participantFound to true
      end try
    end if
    return (chatExists as text) & "," & (accountFound as text) & "," & (participantFound as text)
  end tell
end run`;

const db = new DatabaseSync(`${homedir()}/Library/Messages/chat.db`, { readOnly: true });
const listed = new Set((await osascript(LIST_IDS)).split(', ').filter(Boolean));
const candidates = db
  .prepare(
    `SELECT c.guid, c.chat_identifier AS handle, c.service_name AS service
     FROM chat c WHERE c.style = 45 AND c.chat_identifier LIKE '+%'
     ORDER BY c.ROWID`,
  )
  .all() as { guid: string; handle: string; service: string }[];

// `get service type of accounts` fails with -10000 on macOS 26; the probe looks accounts up one way at a time.
console.log({ chatsListed: listed.size, dbOneToOnePhoneChats: candidates.length });

for (const service of ['iMessage', 'SMS']) {
  const unlisted = candidates.find((c) => c.service === service && !listed.has(c.guid));
  const inList = candidates.find((c) => c.service === service && listed.has(c.guid));
  for (const [label, chat] of [['notInChatsList', unlisted], ['inChatsList', inList]] as const) {
    if (!chat) {
      console.log({ service, label, found: 'no candidate' });
      continue;
    }
    const [chatExists, accountFound, participantFound] = (await osascript(PROBE, [chat.guid, chat.handle, service])).split(',');
    console.log({ service, label, chatExists, accountFound, participantFound });
  }
}
