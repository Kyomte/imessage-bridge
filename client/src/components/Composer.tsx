import { useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react';
import { fileSize } from '../format.ts';
import { fileKind } from '../outbox.ts';
import { KIND_LABEL } from './AttachmentView.tsx';

const MAX_HEIGHT_PX = 140;

/**
 * Enter sends, Shift+Enter adds a line. Files come from the paperclip, a paste, or a
 * drop on the thread (Thread owns the list); Send sends each file as its own message,
 * then the text, like Messages does.
 */
export function Composer({
  service,
  files,
  notice,
  onAddFiles,
  onRemoveFile,
  onSend,
}: {
  service: string;
  files: File[];
  /** Why a file wasn't added (too large), shown above the input. */
  notice: string | null;
  onAddFiles: (files: File[]) => void;
  onRemoveFile: (index: number) => void;
  onSend: (text: string) => void;
}) {
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);

  const resize = () => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT_PX)}px`;
  };

  const canSend = !!text.trim() || files.length > 0;

  const submit = () => {
    if (!canSend) return;
    onSend(text.trim());
    setText('');
    requestAnimationFrame(resize);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  // A pasted screenshot arrives as a file; pasted text keeps the normal behaviour.
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const pasted = Array.from(e.clipboardData.files);
    if (pasted.length === 0) return;
    e.preventDefault();
    onAddFiles(pasted);
  };

  return (
    <form
      className="composer"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <button type="button" className="attach-button" aria-label="Attach files" onClick={() => picker.current?.click()}>
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
          <path d="M21 11.5l-8.6 8.6a5.5 5.5 0 0 1-7.8-7.8l8.6-8.6a3.7 3.7 0 0 1 5.2 5.2l-8.6 8.6a1.8 1.8 0 0 1-2.6-2.6l7.9-7.9" />
        </svg>
      </button>
      <input
        ref={picker}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files?.length) onAddFiles(Array.from(e.target.files));
          e.target.value = ''; // Picking the same file again should still fire.
        }}
      />
      <div className="composer-input">
        {notice && (
          <div className="composer-notice" role="alert">
            {notice}
          </div>
        )}
        {files.length > 0 && (
          <ul className="draft-files" aria-label="Files to send">
            {files.map((file, i) => (
              <li key={`${file.name}-${file.size}-${file.lastModified}-${i}`} className="draft-file">
                <span className="attachment-kind">{KIND_LABEL[fileKind(file)]}</span>
                <span className="draft-file-name sensitive">{file.name || 'attachment'}</span>
                <span className="attachment-size">{fileSize(file.size)}</span>
                <button type="button" aria-label={`Remove ${file.name}`} onClick={() => onRemoveFile(i)}>
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
        <textarea
          ref={ref}
          rows={1}
          value={text}
          placeholder={service === 'iMessage' ? 'iMessage' : 'Text Message'}
          aria-label="Message"
          onChange={(e) => {
            setText(e.target.value);
            resize();
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
        />
      </div>
      <button
        type="submit"
        className={`send-button ${service === 'iMessage' ? 'imessage' : 'sms'}`}
        disabled={!canSend}
        aria-label="Send"
      >
        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden>
          <path d="M12 4l7 7-1.4 1.4L13 7.8V20h-2V7.8l-4.6 4.6L5 11z" />
        </svg>
      </button>
    </form>
  );
}
