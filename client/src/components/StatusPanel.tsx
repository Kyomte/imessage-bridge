import { useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AutomationState, Health } from '@imb/shared';
import { api, type Device } from '../api.ts';
import { listTime } from '../format.ts';

const AUTOMATION_LABEL: Record<AutomationState, string> = {
  unknown: 'Not checked yet',
  checking: 'Checking…',
  granted: 'Allowed',
  denied: 'Not allowed: System Settings → Privacy & Security → Automation → iMessage Bridge → Messages',
  waiting: 'Waiting: click Allow on the prompt on the Mac',
  error: "Couldn't check (is Messages signed in?)",
};

function Row({ label, ok, children }: { label: string; ok: boolean | null; children: ReactNode }) {
  return (
    <div className="status-row">
      <span className={`status-dot ${ok === null ? '' : ok ? 'ok' : 'bad'}`} aria-hidden />
      <span className="status-label">{label}</span>
      <span className="status-value">{children}</span>
    </div>
  );
}

function since(ms: number | null): string {
  if (!ms) return 'never';
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return listTime(ms);
}

function uptime(seconds: number): string {
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)} h`;
  return `${Math.round(seconds / 86_400)} days`;
}

function HealthRows({ health }: { health: Health }) {
  const client = useQueryClient();
  const recheck = useMutation({
    mutationFn: api.recheckAutomation,
    onSuccess: () => client.invalidateQueries({ queryKey: ['health'] }),
  });
  const automation = recheck.data?.state ?? health.automation.state;
  const w = health.watcher;
  return (
    <>
      <Row label="Messages data" ok={health.chatDb.ok}>
        {health.chatDb.ok ? `Readable · ${health.contacts.count} contact numbers/emails` : 'Not readable'}
      </Row>
      <Row label="Messages app" ok={health.messagesAppRunning}>
        {health.messagesAppRunning ? 'Running' : 'Not running (starts when you send)'}
      </Row>
      <Row label="Sending (Automation)" ok={automation === 'granted' ? true : automation === 'checking' ? null : false}>
        {AUTOMATION_LABEL[automation]}{' '}
        <button type="button" className="link-button" disabled={recheck.isPending} onClick={() => recheck.mutate()}>
          Check again
        </button>
      </Row>
      <Row label="Live updates" ok={true}>
        Last change {since(w.lastChangeAt)}
        {w.lastLatencyMs != null && ` · ${(w.lastLatencyMs / 1000).toFixed(1)} s after sending`} · {health.liveClients}{' '}
        connected
      </Row>
      <Row label="Bridge" ok={true}>
        Up {uptime(health.uptimeSeconds)}
      </Row>
    </>
  );
}

function Devices({ me }: { me: Device | undefined }) {
  const client = useQueryClient();
  const { data: devices } = useQuery({ queryKey: ['devices'], queryFn: api.devices });
  const [confirming, setConfirming] = useState<number | null>(null);
  const revoke = useMutation({
    mutationFn: api.revokeDevice,
    onSuccess: () => {
      setConfirming(null);
      client.invalidateQueries({ queryKey: ['devices'] });
    },
  });
  return (
    <ul className="device-list">
      {devices?.map((d) => (
        <li key={d.id}>
          <span className="device-name">
            {d.name}
            {d.id === me?.id && <span className="muted"> (this device)</span>}
          </span>
          <span className="muted">paired {listTime(d.createdAt)} · seen {since(d.lastSeenAt)}</span>
          {d.id !== me?.id &&
            (confirming === d.id ? (
              <button type="button" className="link-button danger" onClick={() => revoke.mutate(d.id)}>
                Confirm revoke
              </button>
            ) : (
              <button type="button" className="link-button" onClick={() => setConfirming(d.id)}>
                Revoke
              </button>
            ))}
        </li>
      ))}
    </ul>
  );
}

export function StatusPanel({ onClose }: { onClose: () => void }) {
  const { data: health, error } = useQuery({ queryKey: ['health'], queryFn: api.health, refetchInterval: 10_000 });
  const { data: me } = useQuery({ queryKey: ['me'], queryFn: api.me });
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="Bridge status" onClick={(e) => e.stopPropagation()}>
        <header className="modal-header">
          <h2>Bridge status</h2>
          <button type="button" className="link-button" onClick={onClose}>
            Close
          </button>
        </header>
        {error && <p className="error">Couldn't reach the Mac.</p>}
        {health && <HealthRows health={health} />}
        <h3>Paired devices</h3>
        <Devices me={me} />
      </div>
    </div>
  );
}
