// Desktop notifications, only inside the Windows tray app (Tauri). The web page is
// served over plain HTTP, where browsers don't offer the Notification API.

import type { QueryClient } from '@tanstack/react-query';
import type { ConversationSummary, Message } from '@imb/shared';

interface TauriNotification {
  isPermissionGranted(): Promise<boolean>;
  requestPermission(): Promise<string>;
  sendNotification(options: { title: string; body?: string }): void;
}

declare global {
  interface Window {
    __TAURI__?: { notification?: TauriNotification };
  }
}

export const inDesktopApp = () => !!window.__TAURI__;

let permission: Promise<boolean> | null = null;

async function allowed(n: TauriNotification): Promise<boolean> {
  permission ??= n.isPermissionGranted().then(async (granted) => granted || (await n.requestPermission()) === 'granted');
  return permission;
}

const openConversation = () => {
  const match = location.hash.match(/^#\/c\/(.+)$/);
  return match ? decodeURIComponent(match[1]) : null;
};

/** The page is in front, focused, and showing this conversation. */
export const isViewing = (conversationId: string) =>
  document.visibilityState === 'visible' && document.hasFocus() && openConversation() === conversationId;

export async function notifyIncoming(client: QueryClient, message: Message) {
  const n = window.__TAURI__?.notification;
  if (!n || message.fromMe) return;
  if (isViewing(message.conversationId)) return;
  if (!(await allowed(n))) return;

  const conversation = client
    .getQueryData<ConversationSummary[]>(['conversations'])
    ?.find((c) => c.id === message.conversationId);
  const sender = message.sender?.display ?? conversation?.title ?? 'New message';
  const title = conversation?.isGroup ? `${sender} · ${conversation.title}` : sender;
  const body = message.text || (message.attachments.length ? 'Attachment' : 'New message');
  n.sendNotification({ title, body });
}
