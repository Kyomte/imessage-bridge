// Creates or updates the server config.
//
//   npm run setup                         first run: generates a pairing password
//   npm run setup -- --rotate-password    new pairing password (paired devices keep working)
//
// The pairing password is written to a 0600 file and never printed.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { parsePhoneNumberFromString } from 'libphonenumber-js';
import { CONFIG_PATH, DATA_DIR, DEFAULTS, PASSWORD_FILE } from '../src/config.ts';
import { generatePassword, hashPassword } from '../src/passwords.ts';

mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
const existing = existsSync(CONFIG_PATH) ? JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) : {};

let passwordHash: string | undefined = existing.passwordHash;
if (!passwordHash || process.argv.includes('--rotate-password')) {
  const password = generatePassword();
  passwordHash = hashPassword(password);
  writeFileSync(PASSWORD_FILE, password + '\n', { mode: 0o600 });
  chmodSync(PASSWORD_FILE, 0o600);
  console.log(`Pairing password written to ${PASSWORD_FILE}`);
}

const config = {
  port: existing.port ?? DEFAULTS.port,
  passwordHash,
  tailscaleLogin: existing.tailscaleLogin ?? detectTailscaleLogin(),
  defaultRegion: existing.defaultRegion ?? detectRegion(),
};
writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
chmodSync(CONFIG_PATH, 0o600);

console.log(`Config written to ${CONFIG_PATH}`);
console.log(`  port: ${config.port}`);
console.log(`  tailscale login check: ${config.tailscaleLogin ? 'on' : 'off (tailscale not found)'}`);
console.log(`  default phone region: ${config.defaultRegion}`);

function detectTailscaleLogin(): string | null {
  try {
    const status = JSON.parse(execFileSync('tailscale', ['status', '--json'], { encoding: 'utf8' }));
    return status.User?.[status.Self?.UserID]?.LoginName ?? null;
  } catch {
    return null;
  }
}

/** Most common country among +E.164 handles in chat.db. */
function detectRegion(): string {
  try {
    const db = new DatabaseSync(DEFAULTS.chatDbPath, { readOnly: true });
    const handles = db.prepare("SELECT id FROM handle WHERE id LIKE '+%'").all() as { id: string }[];
    db.close();
    const counts = new Map<string, number>();
    for (const { id } of handles) {
      const country = parsePhoneNumberFromString(id)?.country;
      if (country) counts.set(country, (counts.get(country) ?? 0) + 1);
    }
    return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'US';
  } catch {
    return 'US';
  }
}
