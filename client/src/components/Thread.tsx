import { useMemo } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Virtuoso } from 'react-virtuoso';
import type { ConversationSummary } from '@imb/shared';
import { api } from '../api.ts';
import { useConversations } from './ConversationList.tsx';
import { Avatar } from './Avatar.tsx';
import { MessageRow } from './MessageRow.tsx';

// Virtuoso prepends by lowering firstItemIndex, so start high.
const START_INDEX = 1_000_000;

interface ListContext {
  loadingOlder: boolean;
  hasOlder: boolean;
}

function HistoryEdge({ context }: { context?: ListContext }) {
  let label = '';
  if (context?.loadingOlder) label = 'Loading earlier messages…';
  else if (!context?.hasOlder) label = 'Start of conversation';
  return <div className="history-edge">{label}</div>;
}

const Footer = () => <div className="thread-footer" />;

function subtitle(c: ConversationSummary): string {
  if (c.isGroup) return `${c.participants.length} people · ${c.service}`;
  const [p] = c.participants;
  // The title already shows the contact name, so show the number here.
  return p?.name ? `${p.handle} · ${c.service}` : c.service;
}

export function Thread({ conversationId, onBack }: { conversationId: string; onBack: () => void }) {
  const { data: conversations } = useConversations();
  const conversation = conversations?.find((c) => c.id === conversationId);

  const query = useInfiniteQuery({
    queryKey: ['messages', conversationId],
    queryFn: ({ pageParam }) => api.messages(conversationId, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

  // Pages arrive newest first; each page is oldest first.
  const messages = useMemo(
    () => (query.data ? [...query.data.pages].reverse().flatMap((p) => p.messages) : []),
    [query.data],
  );
  const byId = useMemo(() => new Map(messages.map((m) => [m.id, m])), [messages]);
  const lastSentId = useMemo(() => messages.findLast((m) => m.fromMe)?.id, [messages]);
  const firstItemIndex = START_INDEX - messages.length;

  return (
    <section className="thread">
      <header className="thread-header">
        <button className="back" onClick={onBack} aria-label="Back to conversations">
          ‹
        </button>
        {conversation && (
          <>
            <Avatar name={conversation.title} group={conversation.isGroup} size={32} />
            <div className="thread-heading">
              <div className="thread-title sensitive">{conversation.title}</div>
              <div className="thread-subtitle sensitive">{subtitle(conversation)}</div>
            </div>
          </>
        )}
      </header>

      {query.isLoading && <div className="thread-status">Loading…</div>}
      {query.error && <div className="thread-status error">Couldn't load messages.</div>}
      {query.data && (
        <Virtuoso
          className="messages"
          data={messages}
          firstItemIndex={firstItemIndex}
          initialTopMostItemIndex={{ index: 'LAST', align: 'end' }}
          startReached={() => {
            if (query.hasNextPage && !query.isFetchingNextPage) query.fetchNextPage();
          }}
          followOutput="smooth"
          computeItemKey={(_, m) => m.id}
          context={{ loadingOlder: query.isFetchingNextPage, hasOlder: query.hasNextPage }}
          components={{ Header: HistoryEdge, Footer }}
          itemContent={(index, m) => {
            const i = index - firstItemIndex;
            return (
              <MessageRow
                message={m}
                previous={messages[i - 1]}
                next={messages[i + 1]}
                isGroup={conversation?.isGroup ?? false}
                replyTo={m.replyToId ? byId.get(m.replyToId) : undefined}
                showStatus={m.id === lastSentId}
              />
            );
          }}
        />
      )}
    </section>
  );
}
