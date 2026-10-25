import type { ConversationSummary, MessagePage, PairResponse } from '@imb/shared';

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

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {};
  if (init.body) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(BASE + path, { ...init, headers });
  if (res.status === 401 && token) {
    setToken(null);
    window.dispatchEvent(new Event('imb:unauthorized'));
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, body.error ?? res.statusText);
  }
  return res.json() as Promise<T>;
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
};
