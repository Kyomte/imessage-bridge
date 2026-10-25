import { useEffect } from 'react';

const RETRY_MS = 5000;

/** Shown while the Mac bridge can't read Messages data (no Full Disk Access yet). */
export function NeedsAccess() {
  // The server restarts itself once access is granted; reload when the API answers again.
  useEffect(() => {
    const timer = setInterval(async () => {
      const res = await fetch('/api/conversations').catch(() => null);
      if (res && res.status !== 503) location.reload();
    }, RETRY_MS);
    return () => clearInterval(timer);
  }, []);

  return (
    <div className="pair">
      <div className="pair-card">
        <h1>One step left on the Mac</h1>
        <p className="muted">The bridge is running but macOS hasn't let it read your messages yet.</p>
        <ol className="steps">
          <li>
            On the Mac, open <strong>System Settings → Privacy &amp; Security → Full Disk Access</strong>.
          </li>
          <li>
            Click <strong>+</strong> and choose <code>~/Applications/iMessage Bridge.app</code>, then switch it on.
          </li>
          <li>If macOS later asks whether iMessage Bridge may control Messages, click Allow.</li>
        </ol>
        <p className="muted">This page reconnects by itself once access is granted.</p>
      </div>
    </div>
  );
}
