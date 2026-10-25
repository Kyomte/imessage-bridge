// Sends text through Messages.app with osascript, one at a time, and matches each
// send to the chat.db row Messages writes for it.
//
// AppleScript doesn't return the new message's guid, so a send stays 'sending'
// until the watcher reports a fromMe message with the same text in the same chat.
// No match within confirmTimeoutMs → 'unconfirmed' (it may still have gone out).

import { execFile } from 'node:child_process';
import type { SendState, SendStatus, ServerEvent } from '@imb/shared';
import type { Watcher } from './watcher.ts';

export type RunOsascript = (script: string, args: string[]) => Promise<void>;

// Arguments arrive as argv, never spliced into the script source:
//   1 chat guid, 2 text, 3 handle ("" for groups), 4 service ("iMessage" | "SMS").
// AppleScript only lists chats Messages has loaded, so for an older
// 1:1 chat it sends to the participant on the matching account instead (M3 probe).
export const SEND_TEXT_SCRIPT = `
on run argv
  set chatGuid to item 1 of argv
  set messageText to item 2 of argv
  set handleId to item 3 of argv
  set serviceName to item 4 of argv
  tell application "Messages"
    if exists chat id chatGuid then
      send messageText to chat id chatGuid
    else if handleId is not "" then
      if serviceName is "iMessage" then
        set targetAccount to first account whose service type is iMessage
      else
        set targetAccount to first account whose service type is SMS
      end if
      send messageText to participant handleId of targetAccount
    else
      error "Can't get chat id " & chatGuid number -1728
    end if
  end tell
end run`;

export interface SendTarget {
  conversationId: string;
  /** The other person's handle for 1:1 chats; null for groups. */
  handle: string | null;
  service: string;
}

const OSASCRIPT_TIMEOUT_MS = 20_000;
const MAX_REMEMBERED = 500;

export const runOsascript: RunOsascript = (script, args) =>
  new Promise((resolve, reject) => {
    execFile('osascript', ['-e', script, ...args], { timeout: OSASCRIPT_TIMEOUT_MS }, (err, _stdout, stderr) => {
      if (err) reject(new Error(String(stderr || err.message).trim()));
      else resolve();
    });
  });

/** Turns osascript errors into something a person can act on. */
export function describeSendError(message: string): string {
  if (message.includes('-1743') || /not authori[sz]ed/i.test(message)) {
    return "The Mac isn't allowed to control Messages yet (System Settings → Privacy & Security → Automation).";
  }
  if (message.includes('-1728') || /can.t get chat/i.test(message)) return 'Messages could not find this conversation.';
  if (/timed? ?out|ETIMEDOUT|SIGTERM/i.test(message)) return 'Messages did not respond in time.';
  return 'Messages could not send this message.';
}

const normalize = (text: string) => text.replace(/\r\n/g, '\n').trim();

type Listener = (status: SendStatus) => void;

export class Sender {
  #run: RunOsascript;
  #confirmTimeoutMs: number;
  #queue: SendStatus[] = [];
  #busy = false;
  /** Sends waiting for their chat.db row, oldest first. */
  #awaiting: { status: SendStatus; target: SendTarget; text: string; timer: NodeJS.Timeout }[] = [];
  #jobs = new Map<string, { target: SendTarget; text: string }>();
  #known = new Map<string, SendStatus>();
  #listeners = new Set<Listener>();

  constructor(watcher: Watcher, { run = runOsascript, confirmTimeoutMs = 30_000 } = {}) {
    this.#run = run;
    this.#confirmTimeoutMs = confirmTimeoutMs;
    watcher.subscribe((events) => this.#onEvents(events));
  }

  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Queues a send. Repeating a clientId returns the existing status instead of sending again. */
  send(target: SendTarget, text: string, clientId: string): SendStatus {
    const existing = this.#known.get(clientId);
    if (existing) return { ...existing };

    const status: SendStatus = {
      clientId,
      conversationId: target.conversationId,
      state: 'queued',
      messageId: null,
      error: null,
    };
    this.#remember(status);
    this.#jobs.set(clientId, { target, text });
    this.#queue.push(status);
    // Copy first: draining starts synchronously and may move the state on before we return.
    const accepted = { ...status };
    void this.#drain();
    return accepted;
  }

  #remember(status: SendStatus) {
    this.#known.set(status.clientId, status);
    while (this.#known.size > MAX_REMEMBERED) {
      const oldest = this.#known.keys().next().value!;
      this.#known.delete(oldest);
      this.#jobs.delete(oldest);
    }
  }

  #update(status: SendStatus, state: SendState, changes: Partial<SendStatus> = {}) {
    Object.assign(status, { state, ...changes });
    for (const listener of this.#listeners) listener({ ...status });
  }

  async #drain() {
    if (this.#busy) return;
    this.#busy = true;
    try {
      for (let status = this.#queue.shift(); status; status = this.#queue.shift()) {
        const { target, text } = this.#jobs.get(status.clientId)!;
        // Wait for the row before running, in case Messages writes it before osascript returns.
        const timer = setTimeout(() => this.#expire(status), this.#confirmTimeoutMs);
        timer.unref();
        this.#awaiting.push({ status, target, text: normalize(text), timer });
        this.#update(status, 'sending');
        try {
          await this.#run(SEND_TEXT_SCRIPT, [target.conversationId, text, target.handle ?? '', target.service]);
        } catch (err) {
          this.#stopAwaiting(status);
          this.#update(status, 'failed', { error: describeSendError(err instanceof Error ? err.message : String(err)) });
        }
      }
    } finally {
      this.#busy = false;
    }
  }

  #stopAwaiting(status: SendStatus) {
    const index = this.#awaiting.findIndex((a) => a.status === status);
    if (index >= 0) {
      clearTimeout(this.#awaiting[index].timer);
      this.#awaiting.splice(index, 1);
    }
  }

  #expire(status: SendStatus) {
    this.#stopAwaiting(status);
    if (status.state === 'sending') this.#update(status, 'unconfirmed');
  }

  #onEvents(events: ServerEvent[]) {
    for (const event of events) {
      if (event.type === 'message.new' && event.message.fromMe) {
        const { message } = event;
        const match = this.#awaiting.find(
          (a) =>
            a.text === normalize(message.text) &&
            (a.target.conversationId === message.conversationId ||
              // A participant send can land in a chat with a different guid for the same person.
              (a.target.handle !== null && message.conversationId.endsWith(`;${a.target.handle}`))),
        );
        if (!match) continue;
        this.#stopAwaiting(match.status);
        if (message.error !== 0) this.#update(match.status, 'failed', { messageId: message.id, error: 'Not delivered.' });
        else this.#update(match.status, 'sent', { messageId: message.id });
      } else if (event.type === 'message.updated' && event.message.fromMe && event.message.error !== 0) {
        // Messages marks a send failed after the fact (e.g. no network on the iPhone for SMS).
        for (const status of this.#known.values()) {
          if (status.messageId === event.message.id && status.state === 'sent') {
            this.#update(status, 'failed', { error: 'Not delivered.' });
          }
        }
      }
    }
  }
}
