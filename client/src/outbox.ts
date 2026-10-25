// Sends started from this device, shown in the thread until the real chat.db
// message replaces them. Kept in the query cache under ['outbox'].

import { useQuery, type QueryClient } from '@tanstack/react-query';
import type { SendState, SendStatus } from '@imb/shared';
import { api, newClientId } from './api.ts';

export interface PendingSend {
  clientId: string;
  conversationId: string;
  text: string;
  service: string;
  state: SendState;
  messageId: string | null;
  error: string | null;
  createdAt: number;
}

const KEY = ['outbox'];

const edit = (client: QueryClient, fn: (list: PendingSend[]) => PendingSend[]) =>
  client.setQueryData<PendingSend[]>(KEY, (list) => fn(list ?? []));

export function useOutbox(conversationId: string): PendingSend[] {
  const { data } = useQuery<PendingSend[]>({
    queryKey: KEY,
    queryFn: () => [],
    initialData: [],
    staleTime: Infinity,
  });
  return data.filter((p) => p.conversationId === conversationId);
}

export function applySendStatus(client: QueryClient, status: SendStatus) {
  edit(client, (list) =>
    list.map((p) =>
      p.clientId === status.clientId ? { ...p, state: status.state, messageId: status.messageId, error: status.error } : p,
    ),
  );
}

/** The real message arrived: its pending copy is no longer needed. */
export function settle(client: QueryClient, messageId: string) {
  edit(client, (list) => list.filter((p) => p.messageId !== messageId));
}

export function removePending(client: QueryClient, clientId: string) {
  edit(client, (list) => list.filter((p) => p.clientId !== clientId));
}

/** Adds the pending bubble first (status events can beat the HTTP response), then posts. */
export async function sendText(client: QueryClient, conversationId: string, service: string, text: string) {
  const clientId = newClientId();
  edit(client, (list) => [
    ...list,
    { clientId, conversationId, text, service, state: 'queued', messageId: null, error: null, createdAt: Date.now() },
  ]);
  try {
    await api.send(conversationId, { text, clientId });
  } catch (err) {
    const reason = err instanceof Error && err.message ? err.message : "Couldn't reach the Mac.";
    applySendStatus(client, { clientId, conversationId, state: 'failed', messageId: null, error: reason });
  }
}

export function retry(client: QueryClient, pending: PendingSend) {
  removePending(client, pending.clientId);
  return sendText(client, pending.conversationId, pending.service, pending.text);
}
