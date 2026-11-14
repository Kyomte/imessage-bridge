import {
  NEEDS_FULL_DISK_ACCESS,
  type AutomationState,
  type ConversationSummary,
  type Health,
  type MediaToken,
  type MessagePage,
  type PairResponse,
  type ReadRequest,
  type SendRequest,
  type SendStatus,
} from '@imb/shared';

// Empty for the web build (same origin); the Tauri app will point this at the ts.net URL.
const BASE = import.meta.env.VITE_API_BASE ?? '';
const TOKEN_KEY = 'imb.token';

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Storage unavailable (private window): the session just won't persist.
  }
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Shared handling for a failed response: sign out on 401, explain missing Full Disk Access. */
function failure(status: number, body: { error?: string }, token: string | null, statusText: string): ApiError {
  if (status === 401 && token) {
    setToken(null);
    window.dispatchEvent(new Event('imb:unauthorized'));
  }
  if (status === 503 && body.error === NEEDS_FULL_DISK_ACCESS) {
    window.dispatchEvent(new Event('imb:needs-full-disk-access'));
  }
  return new ApiError(status, body.error ?? statusText);
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {};
  if (init.body) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(BASE + path, { ...init, headers });
  if (!res.ok) throw failure(res.status, await res.json().catch(() => ({})), token, res.statusText);
  return res.json() as Promise<T>;
}

/**
 * Uploads one file to send. XMLHttpRequest rather than fetch, because fetch can't
 * report upload progress. `clientId` goes first: the server reads fields before the file.
 */
function uploadAttachment(
  conversationId: string,
  clientId: string,
  file: File,
  onProgress: (fraction: number) => void,
): Promise<SendStatus> {
  return new Promise((resolve, reject) => {
    const token = getToken();
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${BASE}/api/conversations/${encodeURIComponent(conversationId)}/attachments`);
    if (token) xhr.setRequestHeader('authorization', `Bearer ${token}`);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      let body: { error?: string } = {};
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        // Not JSON (e.g. a proxy error page).
      }
      if (xhr.status >= 200 && xhr.status < 300) return resolve(body as SendStatus);
      if (xhr.status === 413) body = { error: 'This file is too large to send.' };
      reject(failure(xhr.status, body, token, xhr.statusText));
    };
    xhr.onerror = () => reject(new Error("Couldn't reach the Mac."));
    const form = new FormData();
    form.append('clientId', clientId);
    form.append('file', file, file.name);
    xhr.send(form);
  });
}

export const api = {
  pair: (password: string, deviceName: string) =>
    request<PairResponse>('/api/auth/pair', { method: 'POST', body: JSON.stringify({ password, deviceName }) }),

  conversations: () => request<ConversationSummary[]>('/api/conversations'),

  messages: (conversationId: string, before?: string) => {
    const params = new URLSearchParams({ limit: '50' });
    if (before) params.set('before', before);
    return request<MessagePage>(`/api/conversations/${encodeURIComponent(conversationId)}/messages?${params}`);
  },

  mediaToken: () => request<MediaToken>('/api/media-token'),

  health: () => request<Health>('/api/health'),

  recheckAutomation: () =>
    request<{ state: AutomationState; checkedAt: number | null }>('/api/health/automation', { method: 'POST' }),

  me: () => request<Device>('/api/me'),

  devices: () => request<Device[]>('/api/devices'),

  revokeDevice: (id: number) => request<{ ok: true }>(`/api/devices/${id}`, { method: 'DELETE' }),

  send: (conversationId: string, body: SendRequest) =>
    request<SendStatus>(`/api/conversations/${encodeURIComponent(conversationId)}/messages`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  sendAttachment: uploadAttachment,

  markRead: (conversationId: string, body: ReadRequest) =>
    request<ConversationSummary>(`/api/conversations/${encodeURIComponent(conversationId)}/read`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
};

export interface Device {
  id: number;
  name: string;
  createdAt: number;
  lastSeenAt: number | null;
}

export type MediaVariant = 'thumb' | 'preview' | 'original';

export function mediaUrl(attachmentId: string, variant: MediaVariant, token: string, download = false): string {
  const params = new URLSearchParams({ t: token });
  if (download) params.set('download', '1');
  return `${BASE}/api/attachments/${encodeURIComponent(attachmentId)}/${variant}?${params}`;
}

/**
 * Random id for idempotent sends. crypto.randomUUID() needs a secure context and the
 * tailnet URL is plain HTTP, so build it from getRandomValues (available everywhere).
 */
export function newClientId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
}
