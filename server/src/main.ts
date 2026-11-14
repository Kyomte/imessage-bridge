import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyServerOptions } from 'fastify';
import { DATA_DIR, loadConfig } from './config.ts';
import { Contacts } from './contacts.ts';
import { ChatDb, expandHome } from './chatdb/index.ts';
import { Store } from './store.ts';
import { Watcher } from './watcher.ts';
import { Sender } from './sender.ts';
import { Staging } from './staging.ts';
import { Media } from './media.ts';
import { AutomationCheck } from './automation.ts';
import { RotatingLog } from './logs.ts';
import { buildApp } from './app.ts';
import { buildDegradedApp, canRead } from './degraded.ts';

const config = loadConfig();
const clientDir = fileURLToPath(new URL('../../client/dist', import.meta.url));

// Under launchd (see scripts/service) logs go to a rotating file; interactively to stdout.
const logFile = process.env.IMB_LOG_FILE;
const logger: FastifyServerOptions['logger'] = logFile ? { level: 'info', stream: new RotatingLog(logFile) } : true;

// Keep the Mac from idle-sleeping while the bridge runs; caffeinate exits with us.
if (process.env.IMB_KEEP_AWAKE !== '0') {
  spawn('caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' }).unref();
}

if (!canRead(config.chatDbPath)) {
  // Usually: Full Disk Access not granted yet. Explain it in the UI and restart once it is.
  const app = buildDegradedApp(clientDir, logger);
  await app.listen({ host: '127.0.0.1', port: config.port });
  app.log.warn('chat.db is not readable (Full Disk Access?); serving setup instructions');
  setInterval(() => {
    if (canRead(config.chatDbPath)) {
      app.log.info('chat.db readable now; restarting');
      process.exit(0);
    }
  }, 5000);
} else {
  const contacts = new Contacts(config.addressBookDir, config.defaultRegion);
  const store = new Store(DATA_DIR);
  const chatDb = new ChatDb(config.chatDbPath, contacts, config.defaultRegion, { seen: store });
  const watcher = new Watcher(chatDb);
  const sender = new Sender(watcher);
  const automation = new AutomationCheck();
  const media = new Media(chatDb, store, {
    cacheDir: join(homedir(), 'Library/Caches/imessage-bridge/media'),
    attachmentsRoot: join(homedir(), 'Library/Messages/Attachments'),
  });
  const staging = new Staging(expandHome(config.stagingDir));

  const app = buildApp({ config, chatDb, contacts, store, watcher, sender, media, staging, automation, clientDir, logger });

  // Uploads that never became a message (failed, or no row showed up) are deleted after a day.
  // Sent files stay: their chat.db attachment points at the staged file.
  const sweepStaging = () => {
    try {
      const removed = staging.sweep(chatDb.attachmentDirsUnder(staging.root));
      if (removed) app.log.info({ removed }, 'staging sweep');
    } catch {
      app.log.warn('staging sweep failed');
    }
  };
  sweepStaging();
  setInterval(sweepStaging, 60 * 60_000).unref();

  // Metadata only: never the text or recipient.
  sender.subscribe((status) => app.log.info({ state: status.state, error: status.error }, 'send'));

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

  // Ask for the Messages permission now, so the prompt shows up at setup time.
  automation.check().then((state) => app.log.info({ state }, 'Messages automation'));
}
