import type { ReactNode } from 'react';
import type { AttachmentInfo, Message } from '@imb/shared';
import { clockTime, fileSize, sameDay, separatorTime } from '../format.ts';

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

const KIND_LABEL: Record<AttachmentInfo['kind'], string> = {
  image: 'Photo',
  video: 'Video',
  audio: 'Audio',
  file: 'File',
};

function Attachment({ attachment: a }: { attachment: AttachmentInfo }) {
  return (
    <div className={`attachment ${a.available ? '' : 'unavailable'}`}>
      <span className="attachment-kind">{a.isSticker ? 'Sticker' : KIND_LABEL[a.kind]}</span>
      <span className="attachment-name sensitive">{a.name}</span>
      <span className="attachment-size">{a.available ? fileSize(a.size) : 'Not downloaded on Mac'}</span>
    </div>
  );
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
      {!m.retracted && m.attachments.map((a) => <Attachment key={a.id} attachment={a} />)}
      {body}
      {m.editedAt && !m.retracted && <div className="meta">Edited</div>}
      {showStatus && <div className="meta">{status(m)}</div>}
    </div>
  );
}
