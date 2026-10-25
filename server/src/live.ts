// WebSocket at /api/ws: pushes watcher events to paired devices.
//
// The first frame must be {type: 'auth', token} within AUTH_TIMEOUT_MS. After a
// reconnect the client sends {type: 'resume', sinceRowId} and gets the messages it
// missed, or 'resync' if there are too many.

import websocket, { type WebSocket } from '@fastify/websocket';
import type { FastifyInstance } from 'fastify';
import {
  CLOSE_BAD_MESSAGE,
  CLOSE_FORBIDDEN_ORIGIN,
  CLOSE_UNAUTHORIZED,
  type ClientEvent,
  type ServerEvent,
} from '@imb/shared';
import type { ChatDb } from './chatdb/index.ts';
import type { Store } from './store.ts';
import type { Watcher } from './watcher.ts';

const AUTH_TIMEOUT_MS = 5_000;
const PING_INTERVAL_MS = 30_000;
const MAX_REPLAY = 500;

export interface LiveDeps {
  chatDb: ChatDb;
  store: Store;
  watcher: Watcher;
  /** Extra origins allowed to open the socket (e.g. the Tauri app). Same-origin is always allowed. */
  allowedOrigins?: string[];
}

export interface Live {
  clientCount(): number;
  broadcast(event: ServerEvent): void;
  disconnectDevice(deviceId: number): void;
}

function originAllowed(origin: string, host: string | undefined, allowed: string[]): boolean {
  if (allowed.includes(origin)) return true;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export function registerLive(app: FastifyInstance, { chatDb, store, watcher, allowedOrigins = [] }: LiveDeps): Live {
  const clients = new Map<WebSocket, { deviceId: number; alive: boolean }>();

  const send = (socket: WebSocket, event: ServerEvent) => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(event));
  };

  app.register(websocket);
  app.register(async (scope) => {
    const unsubscribe = watcher.subscribe((events) => {
      for (const socket of clients.keys()) for (const event of events) send(socket, event);
    });
    const pinger = setInterval(() => {
      for (const [socket, client] of clients) {
        if (!client.alive) {
          socket.terminate();
          continue;
        }
        client.alive = false;
        socket.ping();
      }
    }, PING_INTERVAL_MS);
    pinger.unref();
    scope.addHook('onClose', async () => {
      clearInterval(pinger);
      unsubscribe();
    });

    scope.get('/api/ws', { websocket: true }, (socket, req) => {
      const origin = req.headers.origin;
      const host = (req.headers['x-forwarded-host'] as string | undefined) ?? req.headers.host;
      if (origin && !originAllowed(origin, host, allowedOrigins)) {
        socket.close(CLOSE_FORBIDDEN_ORIGIN, 'origin not allowed');
        return;
      }

      const authTimer = setTimeout(() => socket.close(CLOSE_UNAUTHORIZED, 'auth timeout'), AUTH_TIMEOUT_MS);

      socket.on('message', (raw) => {
        let event: ClientEvent;
        try {
          event = JSON.parse(raw.toString());
        } catch {
          socket.close(CLOSE_BAD_MESSAGE, 'bad message');
          return;
        }

        const client = clients.get(socket);
        if (!client) {
          const device = event.type === 'auth' && typeof event.token === 'string' ? store.deviceForToken(event.token) : null;
          if (!device) {
            socket.close(CLOSE_UNAUTHORIZED, 'unauthorized');
            return;
          }
          clearTimeout(authTimer);
          clients.set(socket, { deviceId: device.id, alive: true });
          send(socket, { type: 'hello', lastRowId: watcher.lastRowId, serverTime: Date.now() });
          return;
        }

        if (event.type === 'resume' && Number.isSafeInteger(event.sinceRowId)) {
          // Only up to what the watcher has handled; anything newer arrives as a live event.
          const { messages, more } = chatDb.messagesAfter(event.sinceRowId, {
            limit: MAX_REPLAY,
            upTo: watcher.lastRowId,
          });
          if (more) send(socket, { type: 'resync' });
          else for (const message of messages) send(socket, { type: 'message.new', message });
        }
      });

      socket.on('pong', () => {
        const client = clients.get(socket);
        if (client) client.alive = true;
      });
      socket.on('close', () => {
        clearTimeout(authTimer);
        clients.delete(socket);
      });
    });
  });

  return {
    clientCount: () => clients.size,
    broadcast(event) {
      for (const socket of clients.keys()) send(socket, event);
    },
    disconnectDevice(deviceId) {
      for (const [socket, client] of clients) {
        if (client.deviceId === deviceId) socket.close(CLOSE_UNAUTHORIZED, 'device revoked');
      }
    },
  };
}
