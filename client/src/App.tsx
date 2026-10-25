import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getToken, setToken } from './api.ts';
import { connectLive, type LiveStatus } from './live.ts';
import { Pair } from './components/Pair.tsx';
import { ConversationList } from './components/ConversationList.tsx';
import { Thread } from './components/Thread.tsx';
import { usePrivacyBlur } from './usePrivacyBlur.ts';
import { Lightbox } from './components/AttachmentView.tsx';
import { NeedsAccess } from './components/NeedsAccess.tsx';
import { StatusPanel } from './components/StatusPanel.tsx';

export function App() {
  const [token, setTokenState] = useState(getToken);
  const [needsAccess, setNeedsAccess] = useState(false);
  usePrivacyBlur();

  useEffect(() => {
    const onUnauthorized = () => setTokenState(null);
    const onNeedsAccess = () => setNeedsAccess(true);
    window.addEventListener('imb:unauthorized', onUnauthorized);
    window.addEventListener('imb:needs-full-disk-access', onNeedsAccess);
    return () => {
      window.removeEventListener('imb:unauthorized', onUnauthorized);
      window.removeEventListener('imb:needs-full-disk-access', onNeedsAccess);
    };
  }, []);

  if (needsAccess) return <NeedsAccess />;

  if (!token) {
    return (
      <Pair
        onPaired={(t) => {
          setToken(t);
          setTokenState(t);
        }}
      />
    );
  }
  return <Main token={token} />;
}

const selectionFromHash = () => {
  const match = location.hash.match(/^#\/c\/(.+)$/);
  return match ? decodeURIComponent(match[1]) : null;
};

function Main({ token }: { token: string }) {
  const [selected, setSelected] = useState(selectionFromHash);
  const [liveStatus, setLiveStatus] = useState<LiveStatus>('connecting');
  const [stale, setStale] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);
  const queryClient = useQueryClient();

  useEffect(() => connectLive(queryClient, token, setLiveStatus, () => setStale(true)), [queryClient, token]);

  useEffect(() => {
    const onHashChange = () => setSelected(selectionFromHash());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const select = (id: string | null) => {
    location.hash = id ? `/c/${encodeURIComponent(id)}` : '';
  };

  return (
    <div className={`layout ${selected ? 'has-selection' : ''}`}>
      <ConversationList
        selectedId={selected}
        onSelect={select}
        liveStatus={liveStatus}
        stale={stale}
        onOpenStatus={() => setStatusOpen(true)}
      />
      <main className="pane">
        {selected ? (
          <Thread key={selected} conversationId={selected} onBack={() => select(null)} />
        ) : (
          <div className="empty-state">Select a conversation</div>
        )}
      </main>
      <Lightbox />
      {statusOpen && <StatusPanel onClose={() => setStatusOpen(false)} />}
    </div>
  );
}
