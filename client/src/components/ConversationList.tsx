import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Virtuoso } from 'react-virtuoso';
import type { ConversationSummary } from '@imb/shared';
import { api } from '../api.ts';
import { listTime } from '../format.ts';
import type { LiveStatus } from '../live.ts';
import { Avatar } from './Avatar.tsx';

const STATUS_LABEL: Record<LiveStatus, string> = {
  connecting: 'Connecting…',
  live: 'Live',
  offline: 'Offline, reconnecting…',
};

export const useConversations = () => useQuery({ queryKey: ['conversations'], queryFn: api.conversations });

function preview(c: ConversationSummary): string {
  const { text, fromMe, hasAttachments } = c.lastMessage;
  const body = text || (hasAttachments ? 'Attachment' : '');
  return fromMe && body ? `You: ${body}` : body;
}

function matches(c: ConversationSummary, query: string): boolean {
  const q = query.toLowerCase();
  return (
    c.title.toLowerCase().includes(q) ||
    c.participants.some((p) => p.display.toLowerCase().includes(q) || p.handle.toLowerCase().includes(q))
  );
}

export function ConversationList({
  selectedId,
  onSelect,
  liveStatus,
  stale,
}: {
  selectedId: string | null;
  onSelect: (id: string) => void;
  liveStatus: LiveStatus;
  stale: boolean;
}) {
  const { data, isLoading, error } = useConversations();
  const [query, setQuery] = useState('');
  const visible = useMemo(() => (query ? data?.filter((c) => matches(c, query)) : data) ?? [], [data, query]);

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <input
          className="search"
          type="search"
          placeholder="Search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className={`live-status ${liveStatus}`} role="status">
          <span className="live-dot" aria-hidden />
          {STATUS_LABEL[liveStatus]}
        </div>
        {stale && (
          <div className="update-banner" role="status">
            New version available
            <button type="button" onClick={() => location.reload()}>
              Reload
            </button>
          </div>
        )}
      </div>
      {isLoading && <div className="list-status">Loading conversations…</div>}
      {error && <div className="list-status error">Couldn't load conversations.</div>}
      {data && visible.length === 0 && <div className="list-status">No matches</div>}
      <Virtuoso
        className="conversation-list"
        data={visible}
        computeItemKey={(_, c) => c.id}
        itemContent={(_, c) => (
          <button
            className={`conversation ${c.id === selectedId ? 'selected' : ''}`}
            onClick={() => onSelect(c.id)}
          >
            {/* The bridge can't mark messages read on the Mac, so just hide the dot for the open chat. */}
            {c.unreadCount > 0 && c.id !== selectedId && (
              <span className="unread-dot" aria-label={`${c.unreadCount} unread`} />
            )}
            <Avatar name={c.title} group={c.isGroup} />
            <div className="conversation-body">
              <div className="conversation-top">
                <span className="conversation-title sensitive">{c.title}</span>
                <span className="conversation-time">{listTime(c.lastMessage.at)}</span>
              </div>
              <div className="conversation-preview sensitive">{preview(c)}</div>
            </div>
          </button>
        )}
      />
    </aside>
  );
}
