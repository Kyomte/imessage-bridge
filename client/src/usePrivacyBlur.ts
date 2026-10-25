import { useEffect, useState } from 'react';

const KEY = 'imb.blur';

function initial(): boolean {
  if (new URLSearchParams(location.search).has('blur')) return true;
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

/** Ctrl+Shift+B blurs names and message text, e.g. while screen sharing. */
export function usePrivacyBlur() {
  const [blur, setBlur] = useState(initial);

  useEffect(() => {
    document.documentElement.classList.toggle('privacy-blur', blur);
    try {
      localStorage.setItem(KEY, blur ? '1' : '0');
    } catch {
      // ignore
    }
  }, [blur]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        setBlur((b) => !b);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
