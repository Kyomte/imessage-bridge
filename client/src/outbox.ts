// Sends started from this device, shown in the thread until the real chat.db
// message replaces them. Kept in the query cache under ['outbox'].

import { useQuery, type QueryClient } from '@tanstack/react-query';
import type { AttachmentKind, SendState, SendStatus } from '@imb/shared';
import { api, newClientId } from './api.ts';

export interface PendingFile {
  /** Kept so Retry can upload it again. */
  blob: File;
  name: string;
  size: number;
  kind: AttachmentKind;
  /** Object URL for an image preview; revoked when the pending row goes away. */
  previewUrl: string | null;
}

export interface PendingSend {
  clientId: string;
  conversationId: string;
  text: string;
  file?: PendingFile;
  /** Upload progress 0–1 while a file is uploading; null otherwise. */
  progress: number | null;
  service: string;
  state: SendState;
  messageId: string | null;
  error: string | null;
  createdAt: number;
}

const KEY = ['outbox'];

const edit = (client: QueryClient, fn: (list: PendingSend[]) => PendingSend[]) =>
  client.setQueryData<PendingSend[]>(KEY, (list) => fn(list ?? []));

/** Removes the matching rows and frees their previews. */
function drop(client: QueryClient, gone: (p: PendingSend) => boolean) {
  edit(client, (list) => {
    for (const p of list) if (gone(p) && p.file?.previewUrl) URL.revokeObjectURL(p.file.previewUrl);
    return list.filter((p) => !gone(p));
  });
}

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
  drop(client, (p) => p.messageId === messageId);
}

export function removePending(client: QueryClient, clientId: string) {
  drop(client, (p) => p.clientId === clientId);
}

function add(client: QueryClient, pending: Omit<PendingSend, 'state' | 'messageId' | 'error' | 'createdAt'>) {
  edit(client, (list) => [...list, { ...pending, state: 'queued', messageId: null, error: null, createdAt: Date.now() }]);
}

function fail(client: QueryClient, clientId: string, conversationId: string, err: unknown) {
  const reason = err instanceof Error && err.message ? err.message : "Couldn't reach the Mac.";
  applySendStatus(client, { clientId, conversationId, state: 'failed', messageId: null, error: reason });
}

async function postText(client: QueryClient, conversationId: string, clientId: string, text: string) {
  try {
    await api.send(conversationId, { text, clientId });
  } catch (err) {
    fail(client, clientId, conversationId, err);
  }
}

/** Adds the pending bubble first (status events can beat the HTTP response), then posts. */
export function sendText(client: QueryClient, conversationId: string, service: string, text: string) {
  const clientId = newClientId();
  add(client, { clientId, conversationId, text, service, progress: null });
  return postText(client, conversationId, clientId, text);
}

export function fileKind(file: File): AttachmentKind {
  const top = file.type.split('/')[0];
  return top === 'image' || top === 'video' || top === 'audio' ? top : 'file';
}

/** Adds a file's pending row (image preview or file chip); returns its clientId. */
function addFile(client: QueryClient, conversationId: string, service: string, blob: File): string {
  const clientId = newClientId();
  const kind = fileKind(blob);
  const file: PendingFile = {
    blob,
    name: blob.name || 'attachment',
    size: blob.size,
    kind,
    previewUrl: kind === 'image' ? URL.createObjectURL(blob) : null,
  };
  add(client, { clientId, conversationId, text: '', file, service, progress: null });
  return clientId;
}

async function upload(client: QueryClient, conversationId: string, clientId: string, blob: File) {
  const setProgress = (progress: number | null) =>
    edit(client, (list) => list.map((p) => (p.clientId === clientId ? { ...p, progress } : p)));
  let shown = -1;
  const onProgress = (fraction: number) => {
    // Whole percents only, so a fast upload doesn't re-render hundreds of times.
    const percent = Math.floor(fraction * 100);
    if (percent === shown) return;
    shown = percent;
    setProgress(percent / 100);
  };
  onProgress(0);
  try {
    await api.sendAttachment(conversationId, clientId, blob, onProgress);
  } catch (err) {
    fail(client, clientId, conversationId, err);
  } finally {
    setProgress(null);
  }
}

/** Uploads one file as its own message, with a pending row that shows progress. */
export function sendFile(client: QueryClient, conversationId: string, service: string, blob: File) {
  return upload(client, conversationId, addFile(client, conversationId, service, blob), blob);
}

/**
 * Sends each file as its own message, then the text, in that order, like Messages does.
 * Every pending row shows at once; the uploads run one at a time, because the server
 * queues sends in the order their requests finish.
 */
export async function sendAll(
  client: QueryClient,
  conversationId: string,
  service: string,
  files: File[],
  text: string,
) {
  const steps = files.map((blob) => {
    const clientId = addFile(client, conversationId, service, blob);
    return () => upload(client, conversationId, clientId, blob);
  });
  if (text) {
    const clientId = newClientId();
    add(client, { clientId, conversationId, text, service, progress: null });
    steps.push(() => postText(client, conversationId, clientId, text));
  }
  // A failed step marks its own row failed; the rest still go.
  for (const step of steps) await step();
}

export function retry(client: QueryClient, pending: PendingSend) {
  // Keep the File; only the old preview URL goes.
  removePending(client, pending.clientId);
  if (pending.file) return sendFile(client, pending.conversationId, pending.service, pending.file.blob);
  return sendText(client, pending.conversationId, pending.service, pending.text);
}
