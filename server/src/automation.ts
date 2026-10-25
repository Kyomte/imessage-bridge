// Whether macOS lets this process control Messages (Privacy & Security → Automation).
// There's no API to ask, so it runs a harmless AppleScript. The first run shows the
// "… wants to control Messages" prompt, which is why the check can wait a while.

import { execFile } from 'node:child_process';
import type { AutomationState } from '@imb/shared';

const PROBE = 'tell application "Messages" to count chats';

/** Runs the probe; resolves with the error (if any) and whether it timed out. */
export type RunProbe = (timeoutMs: number) => Promise<{ error: string | null; timedOut: boolean }>;

const runOsascriptProbe: RunProbe = (timeoutMs) =>
  new Promise((resolve) => {
    execFile('osascript', ['-e', PROBE], { timeout: timeoutMs }, (err, _stdout, stderr) =>
      resolve({ error: err ? String(stderr || err.message) : null, timedOut: !!err?.killed }),
    );
  });

export class AutomationCheck {
  state: AutomationState = 'unknown';
  checkedAt: number | null = null;
  #running: Promise<AutomationState> | null = null;
  #probe: RunProbe;

  constructor(probe: RunProbe = runOsascriptProbe) {
    this.#probe = probe;
  }

  /** Runs the probe; while the permission prompt is open it reports 'waiting'. */
  check(timeoutMs = 120_000): Promise<AutomationState> {
    if (this.#running) return this.#running;
    this.state = 'checking';
    this.#running = this.#probe(timeoutMs)
      .then(({ error, timedOut }): AutomationState => {
        if (!error) return 'granted';
        if (/-1743|not authori[sz]ed/i.test(error)) return 'denied';
        return timedOut ? 'waiting' : 'error';
      })
      .then((state) => {
        this.state = state;
        this.checkedAt = Date.now();
        this.#running = null;
        return state;
      });
    return this.#running;
  }

  /** A send failed with -1743: the grant was removed or never given. */
  markDenied() {
    this.state = 'denied';
    this.checkedAt = Date.now();
  }
}
