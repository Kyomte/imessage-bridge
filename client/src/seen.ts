// Marks the open conversation seen in the bridge while you're looking at it, so its
// unread dot stays cleared on every paired device. Messages.app on the Mac only marks
// messages read for a person at the Mac, so the Mac and iPhone keep their own state.

import { useEffect, useRef } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { ConversationSummary } from '@imb/shared';
import { api } from './api.ts';
import { applyConversation } from './live.ts';
import { isViewing } from './notify.ts';

/** Waits this long after opening (or a new message) so a quick click-through doesn't count. */
const DWELL_MS = 1000;

function clearUnread(client: QueryClient, conversationId: string) {
  client.setQueryData<ConversationSummary[]>(['conversations'], (list) =>
    list?.map((c) => (c.id === conversationId && c.unreadCount > 0 ? { ...c, unreadCount: 0 } : c)),
  );
}

/**
 * @param unreadCount the conversation's count from the server (already net of what the bridge has shown)
 * @param newestRowId the highest message rowId loaded in the thread
 */
export function useMarkSeen(conversationId: string, unreadCount: number, newestRowId: number) {
  const client = useQueryClient();
  /** Highest rowId already sent for this conversation. */
  const sent = useRef(0);

  useEffect(() => {
    sent.current = 0;
  }, [conversationId]);

  useEffect(() => {
    if (unreadCount === 0 || newestRowId === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const attempt = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (!isViewing(conversationId) || newestRowId <= sent.current) return;
        sent.current = newestRowId;
        clearUnread(client, conversationId);
        api
          .markRead(conversationId, { upToRowId: newestRowId })
          .then((conversation) => applyConversation(client, conversation))
          .catch(() => {
            // Let the next focus or message try again, and show the server's real count.
            sent.current = 0;
            void client.invalidateQueries({ queryKey: ['conversations'] });
          });
      }, DWELL_MS);
    };
    attempt();
    // Coming back to the window counts as looking at the open chat.
    window.addEventListener('focus', attempt);
    document.addEventListener('visibilitychange', attempt);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('focus', attempt);
      document.removeEventListener('visibilitychange', attempt);
    };
  }, [client, conversationId, unreadCount, newestRowId]);
}
