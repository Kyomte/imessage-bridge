import { fileURLToPath } from 'node:url';
import { DATA_DIR, loadConfig } from './config.ts';
import { Contacts } from './contacts.ts';
import { ChatDb } from './chatdb/index.ts';
import { Store } from './store.ts';
import { Watcher } from './watcher.ts';
import { buildApp } from './app.ts';

const config = loadConfig();
const contacts = new Contacts(config.addressBookDir, config.defaultRegion);
const chatDb = new ChatDb(config.chatDbPath, contacts, config.defaultRegion);
const store = new Store(DATA_DIR);
const watcher = new Watcher(chatDb);
const clientDir = fileURLToPath(new URL('../../client/dist', import.meta.url));

const app = buildApp({ config, chatDb, contacts, store, watcher, clientDir });

// Metadata only: counts, latency and which trigger fired, never content.
watcher.subscribe((events) => {
  const count = (type: string) => events.filter((e) => e.type === type).length;
  app.log.info(
    {
      new: count('message.new'),
      updated: count('message.updated'),
      conversations: count('conversation.updated'),
      latencyMs: count('message.new') ? watcher.stats.lastLatencyMs : null,
      triggers: watcher.stats.triggers,
    },
    'chat.db change',
  );
});
watcher.start({ pollMs: 1000, watchPath: config.chatDbPath });

// Loopback only: remote access goes through `tailscale serve`.
await app.listen({ host: '127.0.0.1', port: config.port });
