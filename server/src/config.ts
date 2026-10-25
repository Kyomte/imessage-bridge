import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DATA_DIR = join(homedir(), 'Library/Application Support/imessage-bridge');
export const CONFIG_PATH = join(DATA_DIR, 'config.json');
export const PASSWORD_FILE = join(DATA_DIR, 'pairing-password.txt');

export interface Config {
  port: number;
  /** scrypt hash of the pairing password, see passwords.ts. */
  passwordHash: string;
  /** Tailnet login that `tailscale serve` must report; null disables the check. */
  tailscaleLogin: string | null;
  /** Region for phone numbers written without a country code, e.g. "PH". */
  defaultRegion: string;
  chatDbPath: string;
  addressBookDir: string;
  /** Extra origins allowed to open the live socket, e.g. the Tauri app's. */
  allowedOrigins?: string[];
}

export const DEFAULTS = {
  port: 7317,
  chatDbPath: join(homedir(), 'Library/Messages/chat.db'),
  addressBookDir: join(homedir(), 'Library/Application Support/AddressBook'),
};

export function loadConfig(): Config {
  let raw: string;
  try {
    raw = readFileSync(CONFIG_PATH, 'utf8');
  } catch {
    throw new Error(`No config at ${CONFIG_PATH}. Run: npm run setup`);
  }
  const config = { ...DEFAULTS, ...JSON.parse(raw) } as Config;
  if (process.env.IMB_PORT) config.port = Number(process.env.IMB_PORT);
  return config;
}
