import { useRef, useState, type KeyboardEvent } from 'react';

const MAX_HEIGHT_PX = 140;

/** Enter sends, Shift+Enter adds a line. */
export function Composer({ service, onSend }: { service: string; onSend: (text: string) => void }) {
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);

  const resize = () => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT_PX)}px`;
  };

  const submit = () => {
    const value = text.trim();
    if (!value) return;
    onSend(value);
    setText('');
    requestAnimationFrame(resize);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <form
      className="composer"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
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
      />
      <button
        type="submit"
        className={`send-button ${service === 'iMessage' ? 'imessage' : 'sms'}`}
        disabled={!text.trim()}
        aria-label="Send"
      >
        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden>
          <path d="M12 4l7 7-1.4 1.4L13 7.8V20h-2V7.8l-4.6 4.6L5 11z" />
        </svg>
      </button>
    </form>
  );
}
