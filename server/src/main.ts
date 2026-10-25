import { fileURLToPath } from 'node:url';
import { DATA_DIR, loadConfig } from './config.ts';
import { Contacts } from './contacts.ts';
import { ChatDb } from './chatdb/index.ts';
import { Store } from './store.ts';
import { buildApp } from './app.ts';

const config = loadConfig();
const contacts = new Contacts(config.addressBookDir, config.defaultRegion);
const chatDb = new ChatDb(config.chatDbPath, contacts, config.defaultRegion);
const store = new Store(DATA_DIR);
const clientDir = fileURLToPath(new URL('../../client/dist', import.meta.url));

const app = buildApp({ config, chatDb, contacts, store, clientDir });

// Loopback only: remote access goes through `tailscale serve`.
await app.listen({ host: '127.0.0.1', port: config.port });
