import type { ReactNode } from 'react';
import type { Message } from '@imb/shared';
import { clockTime, sameDay, separatorTime } from '../format.ts';
import { AttachmentView } from './AttachmentView.tsx';
import type { PendingSend } from '../outbox.ts';

// Messages shows a timestamp separator after an hour of silence.
const GAP_MS = 60 * 60_000;

const startsNewBlock = (prev: Message | undefined, m: Message) =>
  !prev || !sameDay(prev.sentAt, m.sentAt) || m.sentAt - prev.sentAt > GAP_MS;

const author = (m: Message) => (m.fromMe ? 'me' : (m.sender?.handle ?? '?'));

function status(m: Message): string {
  if (m.error !== 0) return 'Not Delivered';
  if (m.service !== 'iMessage') return 'Sent as Text Message';
  if (m.readAt) return `Read ${clockTime(m.readAt)}`;
  if (m.delivered) return 'Delivered';
  return 'Sent';
}

export function MessageRow({
  message: m,
  previous,
  next,
  isGroup,
  replyTo,
  showStatus,
}: {
  message: Message;
  previous?: Message;
  next?: Message;
  isGroup: boolean;
  replyTo?: Message;
  showStatus: boolean;
}) {
  const separator = startsNewBlock(previous, m);
  const runStart = separator || author(previous!) !== author(m);
  const runEnd = !next || startsNewBlock(m, next) || author(next) !== author(m);
  const tone = m.fromMe ? (m.service === 'iMessage' ? 'imessage' : 'sms') : 'them';

  let body: ReactNode = null;
  if (m.retracted) {
    body = <div className="unsent">{m.fromMe ? 'You unsent a message' : 'This message was unsent'}</div>;
  } else if (m.text) {
    body = (
      <div className={`bubble ${tone} sensitive`} title={clockTime(m.sentAt)}>
        {m.text}
      </div>
    );
  } else if (m.attachments.length === 0) {
    body = <div className="bubble unsupported">Unsupported message</div>;
  }

  return (
    <div
      className={`message-row ${m.fromMe ? 'from-me' : 'from-them'} ${runStart ? 'run-start' : ''} ${runEnd ? 'run-end' : ''}`}
    >
      {separator && <div className="separator">{separatorTime(m.sentAt)}</div>}
      {isGroup && !m.fromMe && runStart && <div className="sender sensitive">{m.sender?.display}</div>}
      {m.replyToId && (
        <div className="reply-to sensitive">
          {replyTo ? replyTo.text || 'Attachment' : 'Reply to an earlier message'}
        </div>
      )}
      {!m.retracted && m.attachments.map((a) => <AttachmentView key={a.id} attachment={a} />)}
      {body}
      {m.editedAt && !m.retracted && <div className="meta">Edited</div>}
      {showStatus && <div className="meta">{status(m)}</div>}
    </div>
  );
}

const PENDING_LABEL: Record<PendingSend['state'], string> = {
  queued: 'Sending…',
  sending: 'Sending…',
  sent: 'Sent',
  unconfirmed: 'Sent, but not confirmed. Check your phone.',
  failed: 'Not Delivered',
};

/** A send from this device that chat.db hasn't confirmed yet. */
export function PendingRow({
  pending,
  onRetry,
  onRemove,
}: {
  pending: PendingSend;
  onRetry: () => void;
  onRemove: () => void;
}) {
  const tone = pending.service === 'iMessage' ? 'imessage' : 'sms';
  const failed = pending.state === 'failed';
  const inFlight = pending.state === 'queued' || pending.state === 'sending';
  return (
    <div className="message-row from-me run-start run-end">
      <div className={`bubble ${tone} sensitive ${inFlight ? 'pending' : ''} ${failed ? 'failed' : ''}`}>{pending.text}</div>
      <div className={`meta ${failed ? 'error' : ''}`} role={failed ? 'alert' : undefined}>
        {PENDING_LABEL[pending.state]}
        {failed && pending.error && pending.error !== 'Not delivered.' ? ` · ${pending.error}` : ''}
      </div>
      {failed && (
        <div className="pending-actions">
          <button type="button" onClick={onRetry}>
            Retry
          </button>
          <button type="button" onClick={onRemove}>
            Remove
          </button>
        </div>
      )}
    </div>
  );
}
