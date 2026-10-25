// Fallback server for when chat.db can't be read, almost always because this app
// hasn't been given Full Disk Access yet. It serves the client (which explains what to
// do) and answers every other API call with 503 NEEDS_FULL_DISK_ACCESS. Once the file
// becomes readable the process exits, and launchd starts the full server.

import Fastify, { LogController, type FastifyInstance, type FastifyServerOptions } from 'fastify';
import fastifyStatic from '@fastify/static';
import { closeSync, existsSync, openSync } from 'node:fs';
import { NEEDS_FULL_DISK_ACCESS } from '@imb/shared';

export function canRead(path: string): boolean {
  try {
    closeSync(openSync(path, 'r'));
    return true;
  } catch {
    return false;
  }
}

export function buildDegradedApp(clientDir: string, logger: FastifyServerOptions['logger']): FastifyInstance {
  const app = Fastify({ logger, logController: new LogController({ disableRequestLogging: true }) });
  app.get('/api/ping', async () => ({ ok: true }));
  app.all('/api/*', async (_req, reply) => reply.code(503).send({ error: NEEDS_FULL_DISK_ACCESS }));
  if (existsSync(clientDir)) {
    app.register(fastifyStatic, { root: clientDir });
    app.setNotFoundHandler((_req, reply) => reply.sendFile('index.html'));
  }
  return app;
}
