import Fastify, { LogController, type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { Health, MediaToken, PairResponse, SendRequest } from '@imb/shared';
import type { Config } from './config.ts';
import type { ChatDb } from './chatdb/index.ts';
import type { Contacts } from './contacts.ts';
import type { Device, Store } from './store.ts';
import type { Watcher } from './watcher.ts';
import type { Sender } from './sender.ts';
import { VARIANTS, type Media, type Variant } from './media.ts';
import { verifyPassword } from './passwords.ts';
import { registerLive } from './live.ts';

declare module 'fastify' {
  interface FastifyRequest {
    device?: Device;
  }
}

// /api/ws authenticates with its first frame (see live.ts).
const PUBLIC_ROUTES = new Set(['/api/ping', '/api/auth/pair', '/api/ws']);
const PAIR_WINDOW_MS = 5 * 60_000;
const PAIR_MAX_FAILURES = 5;
const MAX_TEXT_LENGTH = 4000;
const MEDIA_ROUTE = '/api/attachments/:id/:variant';
const SENDS_PER_MINUTE = 30;

export interface AppDeps {
  config: Config;
  chatDb: ChatDb;
  contacts: Contacts;
  store: Store;
  watcher: Watcher;
  sender: Sender;
  media: Media;
  clientDir?: string;
  logger?: boolean;
}

export function buildApp({
  config,
  chatDb,
  contacts,
  store,
  watcher,
  sender,
  media,
  clientDir,
  logger = true,
}: AppDeps): FastifyInstance {
  // Request logging is our own (below) so URLs, which contain phone numbers, never hit the log.
  const app = Fastify({ logger, logController: new LogController({ disableRequestLogging: true }) });

  app.addHook('onResponse', async (req, reply) => {
    req.log.info(
      { method: req.method, route: req.routeOptions.url ?? 'static', status: reply.statusCode, ms: Math.round(reply.elapsedTime) },
      'request',
    );
  });

  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api/')) return;
    // `tailscale serve` sets this for tailnet requests; only the configured login may use the API.
    const login = req.headers['tailscale-user-login'];
    if (login && config.tailscaleLogin && login !== config.tailscaleLogin) {
      return reply.code(403).send({ error: 'forbidden' });
    }
    if (PUBLIC_ROUTES.has(req.routeOptions.url ?? '')) return;
    const token = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
    let device = token ? store.deviceForToken(token) : null;
    // <img>/<video> can't send headers, so attachment URLs may carry a media token instead.
    if (!device && req.routeOptions.url === MEDIA_ROUTE) {
      const mediaToken = (req.query as { t?: unknown }).t;
      if (typeof mediaToken === 'string') device = store.deviceForMediaToken(mediaToken);
    }
    if (!device) return reply.code(401).send({ error: 'unauthorized' });
    req.device = device;
  });

  const live = registerLive(app, {
    chatDb,
    store,
    watcher,
    allowedOrigins: config.allowedOrigins,
    clientBuild: () => (clientDir ? servedBundle(clientDir) : null),
  });
  sender.subscribe((status) => live.broadcast({ type: 'send.status', status }));

  app.get('/api/ping', async () => ({ ok: true }));

  const pairFailures: number[] = [];
  app.post<{ Body: { password?: string; deviceName?: string } }>('/api/auth/pair', async (req, reply) => {
    const now = Date.now();
    while (pairFailures.length && now - pairFailures[0] > PAIR_WINDOW_MS) pairFailures.shift();
    if (pairFailures.length >= PAIR_MAX_FAILURES) return reply.code(429).send({ error: 'too many attempts' });

    const { password, deviceName } = req.body ?? {};
    if (typeof password !== 'string' || !verifyPassword(password, config.passwordHash)) {
      pairFailures.push(now);
      return reply.code(401).send({ error: 'wrong password' });
    }
    const name = typeof deviceName === 'string' && deviceName.trim() ? deviceName.trim().slice(0, 64) : 'device';
    const { device, token } = store.createDevice(name);
    return { token, deviceId: device.id } satisfies PairResponse;
  });

  app.get('/api/me', async (req) => req.device);

  app.get('/api/devices', async () => store.listDevices());

  app.delete<{ Params: { id: string } }>('/api/devices/:id', async (req, reply) => {
    const id = Number(req.params.id);
    if (!store.revokeDevice(id)) return reply.code(404).send({ error: 'not found' });
    live.disconnectDevice(id);
    return { ok: true };
  });

  app.get('/api/health', async (): Promise<Health> => {
    let lastRowId: number | null = null;
    let ok = true;
    try {
      lastRowId = chatDb.lastRowId();
    } catch {
      ok = false;
    }
    return {
      chatDb: { ok, lastRowId },
      contacts: { count: contacts.count },
      messagesAppRunning: isMessagesRunning(),
      watcher: watcher.stats,
      liveClients: live.clientCount(),
    };
  });

  app.get('/api/conversations', async () => chatDb.listConversations());

  app.get<{ Params: { id: string } }>('/api/conversations/:id', async (req, reply) => {
    const conversation = chatDb.getConversation(req.params.id);
    if (!conversation) return reply.code(404).send({ error: 'not found' });
    return conversation;
  });

  app.get<{ Params: { id: string }; Querystring: { before?: string; limit?: string } }>(
    '/api/conversations/:id/messages',
    async (req, reply) => {
      if (!chatDb.getConversation(req.params.id)) return reply.code(404).send({ error: 'not found' });
      try {
        const page = chatDb.listMessages(req.params.id, {
          before: req.query.before,
          limit: req.query.limit ? Number(req.query.limit) : undefined,
        });
        await media.fillSizes(page.messages);
        return page;
      } catch (err) {
        if (err instanceof Error && err.message === 'bad cursor') return reply.code(400).send({ error: 'bad cursor' });
        throw err;
      }
    },
  );

  app.get('/api/media-token', async (req): Promise<MediaToken> => store.createMediaToken(req.device!.id));

  app.get<{ Params: { id: string; variant: string }; Querystring: { download?: string } }>(
    MEDIA_ROUTE,
    async (req, reply) => {
      if (!VARIANTS.has(req.params.variant)) return reply.code(404).send({ error: 'not found' });
      let file;
      try {
        file = await media.get(req.params.id, req.params.variant as Variant);
      } catch (err) {
        // ffmpeg/sips errors name files; strip every path before logging.
        const reason = String(err instanceof Error ? err.message : err).replace(/\/[^\s'"]+/g, '<path>').slice(0, 300);
        req.log.warn({ variant: req.params.variant, reason }, 'media conversion failed');
        return reply.code(422).send({ error: 'could not convert this attachment' });
      }
      if (!file) return reply.code(404).send({ error: 'not found' });
      reply.header('cache-control', 'private, max-age=86400');
      if (req.query.download) reply.header('content-disposition', contentDisposition(file.name));
      return reply.sendFile(basename(file.path), dirname(file.path));
    },
  );

  const recentSends: number[] = [];
  app.post<{ Params: { id: string }; Body: Partial<SendRequest> }>(
    '/api/conversations/:id/messages',
    async (req, reply) => {
      const conversation = chatDb.getConversation(req.params.id);
      if (!conversation) return reply.code(404).send({ error: 'not found' });

      const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
      const clientId = req.body?.clientId;
      if (!text || text.length > MAX_TEXT_LENGTH) {
        return reply.code(400).send({ error: `text is required (max ${MAX_TEXT_LENGTH} characters)` });
      }
      if (typeof clientId !== 'string' || !/^[\w-]{8,64}$/.test(clientId)) {
        return reply.code(400).send({ error: 'clientId is required' });
      }

      // Guards against a client bug sending in a loop.
      const now = Date.now();
      while (recentSends.length && now - recentSends[0] > 60_000) recentSends.shift();
      if (recentSends.length >= SENDS_PER_MINUTE) return reply.code(429).send({ error: 'too many sends' });
      recentSends.push(now);

      const status = sender.send(
        {
          conversationId: conversation.id,
          handle: conversation.isGroup ? null : (conversation.participants[0]?.handle ?? null),
          service: conversation.service,
        },
        text,
        clientId,
      );
      return reply.code(202).send(status);
    },
  );

  // Always registered for reply.sendFile (attachments); it serves files only with a client build.
  const serveClient = !!clientDir && existsSync(clientDir);
  app.register(fastifyStatic, serveClient ? { root: clientDir! } : { root: tmpdir(), serve: false });
  if (serveClient) {
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/')) return reply.sendFile('index.html');
      return reply.code(404).send({ error: 'not found' });
    });
  }

  return app;
}

function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** "index-<hash>.js" from the built index.html; read per call so a rebuild shows up without a restart. */
export function servedBundle(clientDir: string): string | null {
  try {
    return readFileSync(join(clientDir, 'index.html'), 'utf8').match(/assets\/(index-[\w-]+\.js)/)?.[1] ?? null;
  } catch {
    return null;
  }
}

function isMessagesRunning(): boolean {
  try {
    execFileSync('pgrep', ['-x', 'Messages'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
