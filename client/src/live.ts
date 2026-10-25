// Live updates over /api/ws, applied straight into the TanStack Query cache.

import type { InfiniteData, QueryClient } from '@tanstack/react-query';
import {
  CLOSE_UNAUTHORIZED,
  type ClientEvent,
  type ConversationSummary,
  type Message,
  type MessagePage,
  type ServerEvent,
} from '@imb/shared';
import { setToken } from './api.ts';
import { applySendStatus, settle } from './outbox.ts';
import { notifyIncoming } from './notify.ts';

export type LiveStatus = 'connecting' | 'live' | 'offline';

/** This page's own bundle name ("index-<hash>.js"); null in dev, where there's no bundle. */
const OWN_BUILD = import.meta.env.DEV ? null : (new URL(import.meta.url).pathname.split('/').pop() ?? null);

type Pages = InfiniteData<MessagePage, string | undefined>;

const MAX_BACKOFF_MS = 30_000;

function socketUrl(): string {
  const base = import.meta.env.VITE_API_BASE || location.origin;
  return base.replace(/^http/, 'ws') + '/api/ws';
}

const byNewest = (a: ConversationSummary, b: ConversationSummary) => b.lastMessage.at - a.lastMessage.at;
const chronological = (a: Message, b: Message) => a.sentAt - b.sentAt || a.rowId - b.rowId;

export function applyNewMessage(client: QueryClient, message: Message) {
  client.setQueryData<Pages>(['messages', message.conversationId], (data) => {
    if (!data || data.pages.some((p) => p.messages.some((m) => m.id === message.id))) return data;
    const [newest, ...older] = data.pages;
    // iCloud can deliver a row slightly out of order, so keep the newest page sorted.
    const messages = [...newest.messages, message].sort(chronological);
    return { ...data, pages: [{ ...newest, messages }, ...older] };
  });
}

function inCache(client: QueryClient, conversationId: string, messageId: string): boolean {
  const data = client.getQueryData<Pages>(['messages', conversationId]);
  return !!data?.pages.some((p) => p.messages.some((m) => m.id === messageId));
}

export function applyUpdatedMessage(client: QueryClient, message: Message) {
  client.setQueryData<Pages>(['messages', message.conversationId], (data) => {
    if (!data) return data;
    return {
      ...data,
      pages: data.pages.map((page) =>
        page.messages.some((m) => m.id === message.id)
          ? { ...page, messages: page.messages.map((m) => (m.id === message.id ? message : m)) }
          : page,
      ),
    };
  });
}

export function applyConversation(client: QueryClient, conversation: ConversationSummary) {
  client.setQueryData<ConversationSummary[]>(['conversations'], (list) => {
    if (!list) return list;
    const rest = list.filter((c) => c.id !== conversation.id);
    return [conversation, ...rest].sort(byNewest);
  });
}

/** Connects and keeps reconnecting until the returned function is called. */
export function connectLive(
  client: QueryClient,
  token: string,
  onStatus: (status: LiveStatus) => void,
  onStale: () => void,
): () => void {
  let socket: WebSocket | null = null;
  let stopped = false;
  let attempt = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  /** Highest message rowId this client has seen; used to resume after a drop. */
  let lastRowId: number | null = null;

  const send = (event: ClientEvent) => socket?.send(JSON.stringify(event));

  function handle(event: ServerEvent) {
    switch (event.type) {
      case 'hello':
        attempt = 0;
        onStatus('live');
        if (OWN_BUILD && event.clientBuild && event.clientBuild !== OWN_BUILD) onStale();
        if (lastRowId !== null && lastRowId < event.lastRowId) {
          send({ type: 'resume', sinceRowId: lastRowId });
          client.invalidateQueries({ queryKey: ['conversations'] });
        }
        lastRowId = Math.max(lastRowId ?? 0, event.lastRowId);
        break;
      case 'message.new':
        applyNewMessage(client, event.message);
        settle(client, event.message.id);
        void notifyIncoming(client, event.message);
        lastRowId = Math.max(lastRowId ?? 0, event.message.rowId);
        break;
      case 'send.status': {
        const { status } = event;
        applySendStatus(client, status);
        // The message can arrive before its status; then the pending copy is done.
        if (status.messageId && inCache(client, status.conversationId, status.messageId)) {
          settle(client, status.messageId);
        }
        break;
      }
      case 'message.updated':
        applyUpdatedMessage(client, event.message);
        break;
      case 'conversation.updated':
        applyConversation(client, event.conversation);
        break;
      case 'resync':
        client.resetQueries({ queryKey: ['messages'] });
        client.invalidateQueries({ queryKey: ['conversations'] });
        break;
    }
  }

  function open() {
    onStatus('connecting');
    const ws = new WebSocket(socketUrl());
    socket = ws;
    ws.onopen = () => send({ type: 'auth', token });
    ws.onmessage = (e) => handle(JSON.parse(e.data) as ServerEvent);
    ws.onclose = (e) => {
      if (stopped) return;
      onStatus('offline');
      if (e.code === CLOSE_UNAUTHORIZED) {
        setToken(null);
        window.dispatchEvent(new Event('imb:unauthorized'));
        return;
      }
      const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** attempt++);
      retryTimer = setTimeout(open, delay);
    };
  }

  // Reconnect right away when the laptop wakes or the network comes back.
  const reconnectNow = () => {
    if (stopped || socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) return;
    clearTimeout(retryTimer);
    attempt = 0;
    open();
  };
  window.addEventListener('online', reconnectNow);
  document.addEventListener('visibilitychange', reconnectNow);

  open();
  return () => {
    stopped = true;
    clearTimeout(retryTimer);
    window.removeEventListener('online', reconnectNow);
    document.removeEventListener('visibilitychange', reconnectNow);
    socket?.close();
  };
}
