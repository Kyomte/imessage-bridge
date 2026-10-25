// A log file the server rotates itself (launchd can't): JSON lines, moved to
// "<file>.1" once it passes maxBytes, keeping one previous file. Writes are
// synchronous: log volume is small, and it means rotation can't race the file open.

import { closeSync, existsSync, mkdirSync, openSync, renameSync, statSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

export class RotatingLog {
  #path: string;
  #maxBytes: number;
  #bytes: number;
  #fd: number;

  constructor(path: string, maxBytes = 10 * 1024 * 1024) {
    mkdirSync(dirname(path), { recursive: true });
    this.#path = path;
    this.#maxBytes = maxBytes;
    this.#bytes = existsSync(path) ? statSync(path).size : 0;
    this.#fd = openSync(path, 'a');
  }

  write(line: string): boolean {
    this.#bytes += writeSync(this.#fd, line);
    if (this.#bytes > this.#maxBytes) this.#rotate();
    return true;
  }

  #rotate() {
    closeSync(this.#fd);
    renameSync(this.#path, `${this.#path}.1`);
    this.#fd = openSync(this.#path, 'a');
    this.#bytes = 0;
  }
}
