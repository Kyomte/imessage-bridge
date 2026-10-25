import { useEffect, useMemo, useRef } from 'react';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import type { ConversationSummary, Message } from '@imb/shared';
import { api } from '../api.ts';
import { removePending, retry, sendText, useOutbox, type PendingSend } from '../outbox.ts';
import { useConversations } from './ConversationList.tsx';
import { Avatar } from './Avatar.tsx';
import { MessageRow, PendingRow } from './MessageRow.tsx';
import { Composer } from './Composer.tsx';

// Virtuoso prepends by lowering firstItemIndex, so start high.
const START_INDEX = 1_000_000;

type Item = { kind: 'message'; message: Message } | { kind: 'pending'; pending: PendingSend };

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
  const queryClient = useQueryClient();
  const { data: conversations } = useConversations();
  const conversation = conversations?.find((c) => c.id === conversationId);
  const outbox = useOutbox(conversationId);
  const virtuoso = useRef<VirtuosoHandle>(null);
  const justSent = useRef(false);
  const atBottom = useRef(true);

  const query = useInfiniteQuery({
    queryKey: ['messages', conversationId],
    queryFn: ({ pageParam }) => api.messages(conversationId, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    // Live events keep this current; a refetch would shift page boundaries under the list.
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  // Pages arrive newest first; each page is oldest first.
  const messages = useMemo(
    () => (query.data ? [...query.data.pages].reverse().flatMap((p) => p.messages) : []),
    [query.data],
  );
  const byId = useMemo(() => new Map(messages.map((m) => [m.id, m])), [messages]);
  const lastSentId = useMemo(() => messages.findLast((m) => m.fromMe)?.id, [messages]);
  const items = useMemo<Item[]>(
    () => [
      ...messages.map((message) => ({ kind: 'message' as const, message })),
      // Hide a pending send once its real message is in the list.
      ...outbox
        .filter((p) => !(p.messageId && byId.has(p.messageId)))
        .map((pending) => ({ kind: 'pending' as const, pending })),
    ],
    [messages, outbox, byId],
  );

  // Only older pages count as prepended. Live messages and pending sends are appended,
  // so they must not move firstItemIndex or Virtuoso treats them as prepends.
  const olderCount = query.data?.pages.slice(1).reduce((n, p) => n + p.messages.length, 0) ?? 0;
  const firstItemIndex = START_INDEX - olderCount;

  // A pending row grows when it fails or goes unconfirmed (status line, buttons).
  // Virtuoso only follows new items, so keep the bottom pinned for size changes too.
  const outboxStates = outbox.map((p) => `${p.clientId}:${p.state}`).join();
  useEffect(() => {
    if (atBottom.current) {
      requestAnimationFrame(() => virtuoso.current?.scrollToIndex({ index: 'LAST', align: 'end' }));
    }
  }, [outboxStates]);

  const send = (text: string) => {
    if (!conversation) return;
    justSent.current = true;
    void sendText(queryClient, conversationId, conversation.service, text);
    requestAnimationFrame(() => virtuoso.current?.scrollToIndex({ index: 'LAST', align: 'end', behavior: 'smooth' }));
  };

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
          ref={virtuoso}
          className="messages"
          data={items}
          firstItemIndex={firstItemIndex}
          initialTopMostItemIndex={{ index: 'LAST', align: 'end' }}
          startReached={() => {
            if (query.hasNextPage && !query.isFetchingNextPage) query.fetchNextPage();
          }}
          atBottomStateChange={(bottom) => {
            atBottom.current = bottom;
          }}
          followOutput={(isAtBottom) => {
            const follow = isAtBottom || justSent.current;
            justSent.current = false;
            return follow ? 'smooth' : false;
          }}
          computeItemKey={(_, item) => (item.kind === 'message' ? item.message.id : item.pending.clientId)}
          context={{ loadingOlder: query.isFetchingNextPage, hasOlder: query.hasNextPage }}
          components={{ Header: HistoryEdge, Footer }}
          itemContent={(index, item) => {
            if (item.kind === 'pending') {
              return (
                <PendingRow
                  pending={item.pending}
                  onRetry={() => void retry(queryClient, item.pending)}
                  onRemove={() => removePending(queryClient, item.pending.clientId)}
                />
              );
            }
            const i = index - firstItemIndex;
            const at = (j: number) => {
              const neighbour = items[j];
              return neighbour?.kind === 'message' ? neighbour.message : undefined;
            };
            const m = item.message;
            return (
              <MessageRow
                message={m}
                previous={at(i - 1)}
                next={at(i + 1)}
                isGroup={conversation?.isGroup ?? false}
                replyTo={m.replyToId ? byId.get(m.replyToId) : undefined}
                showStatus={m.id === lastSentId}
              />
            );
          }}
        />
      )}
      {conversation && <Composer service={conversation.service} onSend={send} />}
    </section>
  );
}
